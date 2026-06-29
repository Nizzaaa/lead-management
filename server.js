"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const db = require("./db");
const prompts = require("./prompts");
const { researchCompany, discoverCompanies } = require("./research");
const { leadsToCsv, prospectsToCsv, parseCsv, csvRowsToLeads, csvRowsToProspects, parseNumber, leadsToXlsxXml } = require("./exporters");
const { logger, httpLogger } = require("./logger");
const cfAccess = require("./cfAccess");
const caldav = require("./caldav");

// Liest ein Secret bevorzugt aus einer Datei (<NAME>_FILE, Docker-Secret-
// Konvention), sonst aus der Umgebungsvariable. So lässt sich z. B. der
// API-Key als Docker-Secret bereitstellen, statt ihn in der Container-Env
// (sichtbar via `docker inspect`) zu hinterlegen.
function readSecret(name) {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch (err) {
      logger.warn("secret_file_read_failed", { name, error: err.message });
    }
  }
  return process.env[name] || "";
}

const ANTHROPIC_API_KEY = readSecret("ANTHROPIC_API_KEY");

const PORT = process.env.PORT || 3000;

// Erlaubte Einbettungs-Quellen für den iframe (z. B. Nextcloud „External Sites").
// Kommagetrennte Origin-Liste in FRAME_ANCESTORS, z. B.
//   FRAME_ANCESTORS="https://cloud.firma.de"
// Streng validiert (nur http(s)-Origins), damit über die Variable keine
// CSP-Header-Injection möglich ist. Ungültige Einträge werden verworfen.
const FRAME_ANCESTORS = String(process.env.FRAME_ANCESTORS || "")
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter((s) => /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(s));

// Content-Security-Policy: strikt (script-src 'self'), ohne externe Skripte.
// frame-ancestors erlaubt die iframe-Einbettung nur für die konfigurierten
// Origins; ohne Konfiguration wird Einbettung komplett unterbunden ('none').
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'", // Inline-style-Attribute im Markup/JS
  "script-src 'self'",
  "connect-src 'self'",
  FRAME_ANCESTORS.length
    ? `frame-ancestors 'self' ${FRAME_ANCESTORS.join(" ")}`
    : "frame-ancestors 'none'",
].join("; ");

// Abmelde-Ziel des vorgeschalteten Auth-Proxys. Default: Cloudflare Access.
// Per Env überschreibbar (z. B. "/oauth2/sign_out" für oauth2-proxy). Leer =
// kein Logout-Button.
const LOGOUT_URL = String(process.env.LOGOUT_URL || "/cdn-cgi/access/logout").trim();

// --- Anthropic / KI-Setup --------------------------------------------------
// Das SDK wird nur geladen, wenn ein API-Key vorhanden ist. So läuft die App
// auch ohne KI-Konfiguration vollständig (nur die KI-Buttons sind dann inaktiv).

// Auswählbare Modelle. Bewusst auf Modelle beschränkt, die sowohl die Web-Tools
// (web_search/web_fetch) als auch strukturierte Outputs (output_config.format)
// unterstützen – beides wird für die Recherche benötigt.
const AVAILABLE_MODELS = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 – am günstigsten & rate-limit-sicher (Standard)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 – bestes Preis/Leistung (empfohlen)" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 – höchste Qualität, am teuersten" },
];
// Günstigstes Modell als Default, damit nicht versehentlich teuer recherchiert
// wird. Für bessere Dossiers in den Einstellungen auf Sonnet umstellen.
const DEFAULT_MODEL = "claude-haiku-4-5";
const MODEL_SETTING_KEY = "ai_model";

// Aktuell gewähltes Modell (wird beim Start aus der DB geladen).
let currentModel = DEFAULT_MODEL;
const isValidModel = (m) => AVAILABLE_MODELS.some((x) => x.id === m);

let anthropic = null;
// Optionaler Custom-fetch mit Keepalive/langem Body-Timeout für die langen
// Recherche-Streams. Bewusst entkoppelt: Schlägt undici (z. B. wegen Node-
// Version) fehl, bleibt die KI aktiv und nutzt das eingebaute fetch – nur ohne
// dieses Tuning. So legt ein undici-Problem nie die ganze KI lahm.
let aiFetch;
try {
  const { Agent, fetch: undiciFetch } = require("undici");
  // Die agentische Recherche hält lange Streaming-Verbindungen; während der
  // server-seitigen web_search/web_fetch-Schritte fließen teils minutenlang
  // keine Bytes. undicis Default-bodyTimeout (300 s) bricht solche idle
  // Verbindungen sonst ab ("terminated") – der ~5-Min-Abbruch hinter Proxys/NAT.
  const aiDispatcher = new Agent({
    headersTimeout: 600000,                                      // 10 Min bis zum ersten Byte
    bodyTimeout: 0,                                              // kein Idle-Read-Timeout für lange Streams
    connect: { keepAlive: true, keepAliveInitialDelay: 30000 }, // TCP-Keepalive gegen Idle-Drop
  });
  aiFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: aiDispatcher });
} catch (err) {
  logger.warn("undici_keepalive_unavailable", { error: err.message });
}

try {
  if (ANTHROPIC_API_KEY) {
    const Anthropic = require("@anthropic-ai/sdk");
    // maxRetries: das SDK wiederholt 429 (Rate-Limit) automatisch und respektiert
    // dabei den retry-after-Header; auch abgebrochene Verbindungen ("terminated")
    // werden erneut versucht. Default ist 2 – wir erhöhen für die langen,
    // tool-lastigen Recherche-Streams. timeout deckelt einen Einzel-Call.
    // apiKey explizit übergeben, damit auch die Datei-Secret-Variante greift.
    const opts = { apiKey: ANTHROPIC_API_KEY, maxRetries: 5, timeout: 900000 };
    if (aiFetch) opts.fetch = aiFetch;
    anthropic = new Anthropic(opts);
  }
} catch (err) {
  logger.warn("anthropic_sdk_load_failed", { error: err.message });
}

const aiEnabled = () => Boolean(anthropic);

// Erkennt das unsichere Standard-DB-Passwort ("leadpilot"), damit beim Start
// klar gewarnt wird, falls in Produktion vergessen wurde, es zu ändern.
function usingDefaultDbPassword() {
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD === "leadpilot";
  if (process.env.DATABASE_URL) return /:leadpilot@/.test(process.env.DATABASE_URL);
  return false;
}

const STATUSES = ["neu", "kontaktiert", "qualifiziert", "angebot", "gewonnen", "verloren"];

// Abschlusswahrscheinlichkeit je Status (Prozent) für den gewichteten
// Pipeline-Wert (Erwartungswert). In den Einstellungen anpassbar und in der
// DB gespeichert. Startwerte sind übliche B2B-Richtwerte – über echte Deals
// kalibrieren.
const DEFAULT_STAGE_PROBABILITIES = {
  neu: 10, kontaktiert: 20, qualifiziert: 40, angebot: 65, gewonnen: 100, verloren: 0,
};
const STAGE_PROB_SETTING_KEY = "stage_probabilities";
let stageProbabilities = { ...DEFAULT_STAGE_PROBABILITIES };

// „Kalt"-Schwelle: ab so vielen Tagen ohne Aktivität gilt ein offener Lead als
// kalt (clientseitiger 💤-Filter). Hier nur persistiert und ausgeliefert.
const STALE_DAYS_SETTING_KEY = "stale_days";
const DEFAULT_STALE_DAYS = 14;
let staleDays = DEFAULT_STALE_DAYS;

// Tag-Farben (global, case-insensitiv pro Tag-Name): { name: "#rrggbb" }.
const TAG_COLORS_SETTING_KEY = "tag_colors";
let tagColors = {};

// Editierbare KI-Prompts: nur die Abweichungen vom Default werden als JSON
// persistiert (Registry-Logik in prompts.js).
const PROMPTS_SETTING_KEY = "prompt_overrides";

// Automatische Wiedervorlagen (After-Sales): vom System gesetzte Follow-ups,
// ausgelöst durch den Übergang eines Leads nach 'gewonnen'. offsetMonths =
// Fälligkeit relativ zum Abschluss (won_at). Die drei Regeln sind fest
// eingebaut; in den Einstellungen lässt sich nur an-/abschalten, ob sie greifen.
const AUTO_FOLLOWUP_ENABLED_SETTING_KEY = "auto_followup_enabled";
const DEFAULT_AUTO_FOLLOWUP_RULES = [
  { key: "won_reference_3m", enabled: true, offsetMonths: 3, kind: "reference", title: "Nach Referenz fragen" },
  { key: "anniversary_6m", enabled: true, offsetMonths: 6, kind: "anniversary", title: "6-Monats-Jubiläum: Kontakt halten" },
  { key: "anniversary_12m", enabled: true, offsetMonths: 12, kind: "anniversary", title: "12-Monats-Jubiläum: Folgegeschäft anbahnen" },
];
const autoFollowupRules = DEFAULT_AUTO_FOLLOWUP_RULES.map((r) => ({ ...r }));
let autoFollowupEnabled = true;

// Verlustgründe (fest eingebaut). winbackMonths = Zeitversatz für die automatische
// Win-back-Wiedervorlage ab lost_at; null = kein Win-back für diesen Grund.
const LOSS_REASONS = [
  { key: "price",         label: "Preis zu hoch",                 winbackMonths: 6 },
  { key: "competitor",    label: "An Wettbewerber verloren",      winbackMonths: 9 },
  { key: "budget_timing", label: "Kein Budget / falsches Timing", winbackMonths: 6 },
  { key: "no_need",       label: "Kein Bedarf / unpassend",       winbackMonths: null },
  { key: "no_response",   label: "Keine Reaktion / kein Kontakt", winbackMonths: null },
  { key: "other",         label: "Sonstiges",                     winbackMonths: null },
];
const sanitizeLossReason = (v) => (LOSS_REASONS.some((r) => r.key === v) ? v : null);
const WINBACK_ENABLED_SETTING_KEY = "winback_enabled";
let winbackEnabled = true;

function sanitizeStageProbabilities(input) {
  const out = { ...DEFAULT_STAGE_PROBABILITIES };
  if (input && typeof input === "object") {
    for (const s of STATUSES) {
      if (input[s] === undefined || input[s] === "") continue;
      const n = Math.round(Number(input[s]));
      if (Number.isFinite(n)) out[s] = Math.max(0, Math.min(100, n));
    }
  }
  return out;
}

function sanitizeStaleDays(input) {
  const n = Math.round(Number(input));
  if (!Number.isFinite(n)) return DEFAULT_STALE_DAYS;
  return Math.max(1, Math.min(365, n)); // sinnvolle Grenzen: 1–365 Tage
}

function isHexColor(s) { return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s); }

function sanitizeTagColors(input) {
  const out = {};
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input)) {
      const key = String(k).trim().toLowerCase().slice(0, 40);
      if (key && isHexColor(v)) out[key] = String(v).toLowerCase();
      if (Object.keys(out).length >= 300) break;
    }
  }
  return out;
}

// anchor (ISO-Zeitstempel oder YYYY-MM-DD) + months → "YYYY-MM-DD". UTC-basiert,
// mit Monatsende-Clamp (31.01. + 1 Monat → 28./29.02.). Ohne Datums-Bibliothek.
function addMonthsYMD(anchor, months) {
  const d = anchor ? new Date(anchor) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + Number(months), 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  const p = (n) => String(n).padStart(2, "0");
  return `${target.getUTCFullYear()}-${p(target.getUTCMonth() + 1)}-${p(target.getUTCDate())}`;
}

function sanitizeLead(body = {}) {
  // Begrenzt zugleich die Länge, damit überlange Eingaben (bis 1 MB Body)
  // nicht Speicher/Anzeige aufblähen.
  const clean = (v, max = 1000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  let status = clean(body.status).toLowerCase();
  if (!STATUSES.includes(status)) status = "neu";
  let value = Number(body.value);
  if (!Number.isFinite(value) || value < 0) value = 0;
  // Wiedervorlage-Datum: ausschließlich YYYY-MM-DD akzeptieren, sonst null.
  let nextStepAt = null;
  const ns = clean(body.nextStepAt);
  if (/^\d{4}-\d{2}-\d{2}$/.test(ns) && !Number.isNaN(new Date(ns).getTime())) nextStepAt = ns;
  // Tags: kurze Labels, getrimmt, dedupliziert (case-insensitiv) und gedeckelt.
  // undefined lassen, wenn nicht übergeben → updateLead behält die Bestands-Tags.
  let tags;
  if (Array.isArray(body.tags)) {
    const seen = new Set();
    tags = [];
    for (const t of body.tags) {
      const v = typeof t === "string" ? t.trim().slice(0, 40) : "";
      const key = v.toLowerCase();
      if (v && !seen.has(key)) { seen.add(key); tags.push(v); }
      if (tags.length >= 30) break;
    }
  }
  return {
    name: clean(body.name, 300),
    company: clean(body.company, 300),
    email: clean(body.email, 300),
    phone: clean(body.phone, 100),
    source: clean(body.source, 500),
    status,
    value,
    notes: clean(body.notes, 5000),
    nextStep: clean(body.nextStep, 500),
    nextStepAt,
    tags,
  };
}

// Wie sanitizeLead, aber für Prospects (Discovery-Liste). Begrenzt Längen,
// validiert Potenzial (A–D) und Status (offen/abgelehnt) und parst die
// Kriterien-Spalte (JSON) zurück in ein Objekt.
function sanitizeProspect(body = {}) {
  const clean = (v, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  let potenzial = clean(body.potenzial, 2).toUpperCase();
  if (!["A", "B", "C", "D"].includes(potenzial)) potenzial = "C";
  const status = clean(body.status).toLowerCase() === "abgelehnt" ? "abgelehnt" : "offen";
  return {
    name: clean(body.name, 300),
    website: clean(body.website, 500),
    domain: clean(body.domain, 300),
    ort: clean(body.ort, 200),
    branche: clean(body.branche, 200),
    groesse: clean(body.groesse, 100),
    potenzial,
    potenzialGrund: clean(body.potenzialGrund, 500),
    begruendung: clean(body.begruendung, 2000),
    quelle: clean(body.quelle, 500),
    status,
    kriterien: parseJsonObject(body.kriterienJson),
  };
}

// Parst einen JSON-String aus einer Import-Zelle in ein Objekt (für die
// vollständige KI-Bewertung / das Dossier). Liefert null bei leerem oder
// ungültigem Wert bzw. wenn das Ergebnis kein Objekt ist.
function parseJsonObject(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Ergänzt einen bestehenden (Dubletten-)Lead um FEHLENDE Angaben aus einer
// Import-Zeile, ohne vorhandene Werte zu überschreiben. So lassen sich
// unvollständige Datensätze per Import vervollständigen. Liefert die Namen der
// tatsächlich ergänzten Felder (leer = nichts zu tun / Datensatz war komplett).
async function enrichLead(existing, data, ai, research, req) {
  const filled = [];
  const merged = {
    name: existing.name, company: existing.company, email: existing.email,
    phone: existing.phone, source: existing.source, status: existing.status,
    value: Number(existing.value) || 0, notes: existing.notes,
    nextStep: existing.nextStep, nextStepAt: existing.nextStepAt || null,
  };
  // Leere Textfelder aus dem Import füllen (vorhandene bleiben unangetastet).
  for (const f of ["name", "company", "email", "phone", "source", "notes", "nextStep"]) {
    if (!String(merged[f] || "").trim() && data[f]) { merged[f] = data[f]; filled.push(f); }
  }
  if (!merged.nextStepAt && data.nextStepAt) { merged.nextStepAt = data.nextStepAt; filled.push("nextStepAt"); }
  if ((!merged.value || merged.value === 0) && data.value > 0) { merged.value = data.value; filled.push("Wert"); }
  // Status wird bewusst NICHT überschrieben (Pipeline-Stand bleibt erhalten).

  if (filled.length) await db.updateLead(existing.id, merged);
  if (ai && !existing.ai) { await db.setLeadAi(existing.id, ai); filled.push("KI-Bewertung"); }
  if (research && !existing.research) { await db.updateLeadResearch(existing.id, research); filled.push("Dossier"); }

  if (filled.length) {
    await logActivity(existing.id, {
      type: "system", title: "Per CSV-Import ergänzt",
      body: "Ergänzte Felder: " + filled.join(", "),
    }, actor(req));
  }
  // Wurde beim Ergänzen eine Wiedervorlage gesetzt, diese in Tabelle/Kalender übernehmen.
  if (filled.includes("nextStepAt")) {
    const updated = await db.getLead(existing.id);
    if (updated) await reconcileLeadFollowUps(updated, existing, reqBaseUrl(req));
  }
  return filled;
}

// Reihenfolge/Schlüssel der Felder aus Sektion 1 des Dossiers.
const RESEARCH_FIELD_KEYS = [
  "branche", "adresse", "telefonAllgemein", "ansprechpartner",
  "telefonDurchwahl", "oeffnungszeiten", "mail", "web", "kundenbewertung",
];

// Bereinigt ein vom Frontend manuell bearbeitetes Recherche-Objekt und führt es
// mit dem bestehenden zusammen (so bleiben Metadaten wie markdown/input/model
// erhalten). Akzeptiert nur die bekannten Felder der Dossier-Struktur.
function sanitizeResearch(body = {}, prev = {}) {
  // Großzügig begrenzte Länge je Feld (Dossier-Texte können lang sein), aber
  // gedeckelt gegen aufgeblähte Eingaben.
  const s = (v, max = 10000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const base = prev && typeof prev === "object" ? prev : {};
  const baseFields = (base.fields && typeof base.fields === "object") ? base.fields : {};
  const inFields = (body.fields && typeof body.fields === "object") ? body.fields : {};

  const fields = {};
  for (const k of RESEARCH_FIELD_KEYS) {
    const src = inFields[k] !== undefined ? inFields[k] : baseFields[k];
    fields[k] = { value: s(src && src.value), source: s(src && src.source) };
  }

  const potenziale = Array.isArray(body.potenziale)
    ? body.potenziale
        .slice(0, 50) // Anzahl deckeln
        .map((p) => ({ titel: s(p && p.titel), beschreibung: s(p && p.beschreibung), signal: s(p && p.signal) }))
        .filter((p) => p.titel || p.beschreibung || p.signal)
    : (Array.isArray(base.potenziale) ? base.potenziale : []);

  // Übernimmt einen String-Wert aus dem Body, fällt sonst auf den Bestand zurück.
  const str = (key) => (body[key] !== undefined ? s(body[key]) : s(base[key]));

  return {
    ...base,
    unternehmensname: str("unternehmensname"),
    rechercheStand: str("rechercheStand"),
    ambiguityWarning: str("ambiguityWarning"),
    fields,
    negativeBewertungen: str("negativeBewertungen"),
    einordnung: str("einordnung"),
    eingesetzteSysteme: str("eingesetzteSysteme"),
    schwachstellen: str("schwachstellen"),
    potenziale,
    coldCallStrategie: str("coldCallStrategie"),
    risiken: str("risiken"),
  };
}

// Behandelt "k.A."/leer als unbekannt – verhindert, dass Platzhalter in den
// Stammdatenfeldern landen.
function known(v) {
  if (!v || typeof v !== "string") return "";
  const t = v.trim();
  if (!t || /^k\.?\s?a\.?$/i.test(t) || t === "—") return "";
  return t;
}

// Leitet aus einem Recherche-Objekt die Lead-Stammdaten ab.
function leadFromResearch(research, input) {
  const f = research.fields || {};
  return {
    name: known(f.ansprechpartner && f.ansprechpartner.value),
    company: known(research.unternehmensname) || known(input),
    email: known(f.mail && f.mail.value),
    phone:
      known(f.telefonDurchwahl && f.telefonDurchwahl.value) ||
      known(f.telefonAllgemein && f.telefonAllgemein.value),
    source: known(f.web && f.web.value) || `Recherche: ${input}`,
  };
}

// --- Recherche-Jobs --------------------------------------------------------
// Die Web-Recherche dauert oft 1–2 Minuten und würde einen synchronen Request
// in einen Gateway-Timeout (524) laufen lassen. Daher läuft sie als
// Hintergrund-Job; das Frontend pollt Status + Fortschritt.
const researchJobs = new Map();

// Obergrenze gleichzeitig laufender Recherchen. Jede Recherche ist teuer
// (mehrere KI-Aufrufe + Web-Tools) und langlaufend; ohne Deckel könnte ein
// einzelner Akteur das API-Budget und Server-Ressourcen erschöpfen.
const MAX_CONCURRENT_RESEARCH = 3;

// Lehnt eine neue Recherche ab (429), wenn bereits zu viele laufen.
function allowNewResearch(res) {
  let running = 0;
  for (const j of researchJobs.values()) if (j.status === "running") running++;
  if (running >= MAX_CONCURRENT_RESEARCH) {
    res.status(429).json({
      error: `Es laufen bereits ${MAX_CONCURRENT_RESEARCH} Recherchen. Bitte kurz warten, bis eine abgeschlossen ist.`,
    });
    return false;
  }
  return true;
}

// Übersetzt technische SDK-Fehler in verständliche, handlungsleitende Meldungen.
function friendlyResearchError(raw) {
  const msg = (raw && raw.message) ? String(raw.message) : "";
  const status = raw && raw.status;
  if (status === 429 || /rate.?limit|429/i.test(msg)) {
    return "Rate-Limit erreicht – das API-Kontingent ist gerade ausgeschöpft. Bitte in 1–2 Minuten erneut versuchen (oder in den Einstellungen ein anderes Modell wählen).";
  }
  if (status === 529 || /overloaded|529/i.test(msg)) {
    return "Die KI-API ist momentan überlastet. Bitte kurz warten und erneut versuchen.";
  }
  if (status === 401 || /authentication|invalid x-api-key|401/i.test(msg)) {
    return "API-Schlüssel ungültig oder fehlt. Bitte ANTHROPIC_API_KEY prüfen.";
  }
  return msg ? `Recherche fehlgeschlagen: ${msg.slice(0, 300)}` : "Recherche fehlgeschlagen. Bitte erneut versuchen.";
}

// Hintergrund-Job für lang laufende KI-Aufgaben. `kind` unterscheidet die Art
// ("research" → Ergebnis ist ein Lead; "discovery" → Ergebnis ist eine
// Kandidatenliste). Das Ergebnis liegt generisch in job.result; für die
// Recherche wird zusätzlich job.lead gesetzt (Rückwärtskompatibilität).
function startResearchJob(runner, kind = "research") {
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const job = { id, kind, status: "running", steps: [], result: null, lead: null, error: null, finishedAt: 0, controller };
  researchJobs.set(id, job);

  const onProgress = (text) => {
    if (typeof text !== "string" || !text) return;
    job.steps.push({ t: Date.now(), text });
    if (job.steps.length > 60) job.steps.shift();
  };

  (async () => {
    try {
      const out = await runner(onProgress, controller.signal);
      job.result = out;
      if (kind === "research") job.lead = out;
      job.status = "done";
    } catch (err) {
      if (controller.signal.aborted) {
        job.status = "cancelled";
        job.error = "Recherche abgebrochen.";
      } else {
        logger.error("research_failed", { error: err.message });
        // Technische SDK-Meldungen in verständliche Hinweise übersetzen.
        job.error = friendlyResearchError(err);
        job.status = "error";
      }
    } finally {
      job.finishedAt = Date.now();
    }
  })();

  // Alte, abgeschlossene Jobs aufräumen (älter als 15 Minuten).
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, j] of researchJobs) {
    if (j.finishedAt && j.finishedAt < cutoff) researchJobs.delete(key);
  }
  return job;
}

// Kleiner Wrapper, damit Fehler in async-Handlern sauber als 500 landen.
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    (req.log || logger).error("server_error", { error: err.message, stack: err.stack });
    if (!res.headersSent) res.status(500).json({ error: "Interner Serverfehler." });
  });

// Aktor (handelnder Benutzer) eines Requests – stammt aus den Headern eines
// vorgeschalteten Auth-Proxys (Nextcloud-SSO). Fallback für direkte Zugriffe.
function actor(req) {
  return (req && req.actor) || "—";
}

// Öffentliche Basis-URL der App (für den Rücklink zum Lead im Kalender-Termin).
// Hinter Cloudflare/Traefik setzen die Forwarded-Header die externe Adresse;
// modul-seitig hat eine explizit gesetzte APP_BASE_URL Vorrang (siehe caldav.js).
function reqBaseUrl(req) {
  if (!req || !req.headers) return "";
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  return host ? `${proto}://${host}` : "";
}

// Schlankes In-Memory-Rate-Limiting (Fixed Window) ohne externe Abhängigkeit.
// Schützt die kostenpflichtigen KI-Endpunkte vor Missbrauch (Kosten-/Quota-
// Erschöpfung). Schlüssel ist der SSO-Aktor (pro Benutzer), sonst die IP.
function rateLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }
  return (req, res, next) => {
    const now = Date.now();
    const key = (req.actor && req.actor !== "—" ? req.actor : "") || req.ip || "anon";
    let rec = hits.get(key);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(key, rec);
    }
    rec.count++;
    // Gelegentlich abgelaufene Einträge aufräumen, damit die Map nicht wächst.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    if (rec.count > max) {
      const retry = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json({
        error: `Zu viele KI-Anfragen. Bitte in ${retry}s erneut versuchen.`,
      });
    }
    next();
  };
}

// 30 KI-Anfragen pro 5 Minuten je Akteur – großzügig für normale Nutzung,
// bremst aber automatisierten Missbrauch der teuren KI-Endpunkte.
const aiLimiter = rateLimiter({ windowMs: 5 * 60 * 1000, max: 30 });

// Schreibt einen Aktivitäts-Eintrag, ohne den Hauptablauf scheitern zu lassen.
async function logActivity(leadId, fields, who) {
  if (!leadId) return;
  try {
    await db.createActivity({ leadId, actor: who || "—", ...fields });
  } catch (err) {
    logger.warn("activity_log_failed", { leadId, error: err.message });
  }
}

// Legt beim Übergang nach 'gewonnen' die automatischen After-Sales-
// Wiedervorlagen an (Referenz/Jubiläum). Eager mit zukünftigem Fälligkeitsdatum –
// die „Heute"-Sicht ist eine passive Datumsabfrage, daher braucht es keinen
// Scheduler. Idempotent (Unique-Index). Reine DB-Arbeit; den Kalender gleicht
// der aufrufende Handler im Anschluss für alle offenen Wiedervorlagen an.
async function applyAutoFollowUps(lead, prevStatus) {
  if (!autoFollowupEnabled) return;
  if (!lead || lead.status !== "gewonnen" || prevStatus === "gewonnen") return;
  const anchor = lead.wonAt || lead.updatedAt;
  for (const rule of autoFollowupRules) {
    if (!rule.enabled) continue;
    const dueDate = addMonthsYMD(anchor, rule.offsetMonths);
    if (!dueDate) continue;
    const created = await db.createAutoFollowUp({
      leadId: lead.id, kind: rule.kind, ruleKey: rule.key, title: rule.title, dueDate,
    });
    if (created) {
      await logActivity(lead.id,
        { type: "system", title: `Automatische Wiedervorlage: ${rule.title} (${dueDate})` }, "System");
    }
  }
  await db.syncLeadMirror(lead.id);
}

// Legt beim Übergang nach 'verloren' – je nach Verlustgrund – eine zukünftige
// Win-back-Wiedervorlage an („wieder anbahnen"). Nutzt dieselbe idempotente
// Engine wie die After-Sales-Wiedervorlagen (Unique-Index je lead_id+rule_key).
async function applyWinBackFollowUp(lead, prevStatus) {
  if (!winbackEnabled) return;
  if (!lead || lead.status !== "verloren" || prevStatus === "verloren") return;
  const reason = LOSS_REASONS.find((r) => r.key === lead.lossReason);
  if (!reason || !reason.winbackMonths) return;
  const dueDate = addMonthsYMD(lead.lostAt || lead.updatedAt, reason.winbackMonths);
  if (!dueDate) return;
  const created = await db.createAutoFollowUp({
    leadId: lead.id, kind: "winback", ruleKey: `winback_${reason.key}`,
    title: `Wieder anbahnen (war: ${reason.label})`, dueDate,
  });
  if (created) {
    await logActivity(lead.id,
      { type: "system", title: `Win-back geplant: ${reason.label} (${dueDate})` }, "System");
  }
  await db.syncLeadMirror(lead.id);
}

// Zieht die Auto-Wiedervorlagen für bereits gewonnene Leads nach (Altbestand /
// neu hinzugekommene Regeln). Idempotent und nur für Regeln, deren Fälligkeit in
// der ZUKUNFT liegt – längst vergangene Jubiläen sollen nicht als „überfällig"
// aufpoppen. Läuft einmal beim Start, ohne Kalender-Aufrufe.
async function backfillAutoFollowUps() {
  if (!autoFollowupEnabled) return;
  const today = addMonthsYMD(null, 0); // heutiges Datum als YYYY-MM-DD
  const leads = await db.listLeads();
  for (const lead of leads) {
    if (lead.status !== "gewonnen") continue;
    const anchor = lead.wonAt || lead.updatedAt;
    let createdAny = false;
    for (const rule of autoFollowupRules) {
      if (!rule.enabled) continue;
      const dueDate = addMonthsYMD(anchor, rule.offsetMonths);
      if (!dueDate || dueDate <= today) continue; // nur zukünftige Fälligkeiten
      const created = await db.createAutoFollowUp({
        leadId: lead.id, kind: rule.kind, ruleKey: rule.key, title: rule.title, dueDate,
      });
      if (created) createdAny = true;
    }
    if (createdAny) await db.syncLeadMirror(lead.id);
  }
}

// Legacy-Brücke: hält EINE manuelle Wiedervorlage passend zum Lead-Spiegel
// (next_step/next_step_at, gesetzt vom alten Modal bzw. Import) und gleicht die
// betroffenen Kalender-Termine an. Best-effort, blockiert den Request nicht.
async function reconcileLeadFollowUps(lead, prevLead, baseUrl) {
  if (!lead) return;
  try {
    const shim = await db.upsertManualFollowUpFromMirror(lead.id);
    if (!caldav.isEnabled()) return;
    for (const fu of shim.dismissed) caldav.removeFollowUp(fu.id);
    const newlyId = shim.upserted && shim.upserted.id;
    for (const fu of await db.listFollowUps(lead.id)) {
      if (fu.status !== "open") continue;
      const prev = fu.id === newlyId ? null : { lead: prevLead || lead, followUp: fu };
      caldav.syncFollowUp(lead, fu, prev, baseUrl);
    }
  } catch (err) {
    logger.warn("reconcile_follow_ups_failed", { leadId: lead && lead.id, error: err.message });
  }
}

// --- App -------------------------------------------------------------------
const app = express();
app.use(httpLogger());
app.use(express.json({ limit: "1mb" }));

// Security-Header auf jede Antwort setzen. Bewusst als schlanke eigene
// Middleware statt einer zusätzlichen Abhängigkeit (helmet), passend zur
// dependency-freien Architektur. Setzt eine strikte CSP, verhindert
// MIME-Sniffing und Clickjacking und begrenzt Referrer/Browser-Features.
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // Clickjacking-Schutz auch für Clients ohne CSP-frame-ancestors. Nur wenn
  // KEINE Einbettung erlaubt ist – sonst würde es die iframe-Nutzung in
  // Nextcloud blockieren (X-Frame-Options kann keine Allowlist abbilden).
  if (!FRAME_ANCESTORS.length) res.setHeader("X-Frame-Options", "DENY");
  next();
});

// Cloudflare-Access-JWT erzwingen (nur wenn CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD
// gesetzt sind). Schützt die sensiblen API-Routen kryptografisch – auch falls die
// App unter Umgehung von Cloudflare direkt erreicht wird. Die verifizierte E-Mail
// wird zum autoritativen Aktor. Ausgenommen: /api/config (Healthcheck) und
// /api/widget (serverseitiger homepage-Abruf im internen Netz). Statische Assets
// bleiben offen (nur SPA-Hülle, keine Daten).
const CF_EXEMPT = new Set(["/api/config", "/api/widget"]);
if (cfAccess.isEnabled()) {
  logger.info("cf_access_enabled", { issuer: cfAccess.ISSUER });
  app.use(async (req, res, next) => {
    if (!req.path.startsWith("/api/") || CF_EXEMPT.has(req.path)) return next();
    try {
      const id = await cfAccess.verifyRequest(req);
      req.actor = id.email || "—";
      if (req.log && id.email) req.log = req.log.child({ actor: id.email });
      next();
    } catch (err) {
      if (err && err.code === "JWKS_UNAVAILABLE") {
        (req.log || logger).error("cf_access_jwks_unavailable", { error: err.message });
        return res.status(503).json({ error: "Authentifizierung vorübergehend nicht verfügbar. Bitte erneut versuchen." });
      }
      (req.log || logger).warn("cf_access_denied", { path: req.path, error: err.message });
      return res.status(403).json({ error: "Zugriff verweigert: Cloudflare-Access-Token fehlt oder ist ungültig." });
    }
  });
}

app.use(express.static(path.join(__dirname, "public")));

// Health / Konfiguration
app.get("/api/config", (req, res) => {
  res.json({
    aiEnabled: aiEnabled(),
    caldavEnabled: caldav.isEnabled(),
    model: currentModel,
    models: AVAILABLE_MODELS,
    statuses: STATUSES,
    stageProbabilities,
    staleDays,
    autoFollowupEnabled,
    winbackEnabled,
    lossReasons: LOSS_REASONS,
    tagColors,
    user: actor(req) !== "—" ? actor(req) : "",
    logoutUrl: LOGOUT_URL,
  });
});

// Einstellungen lesen
app.get("/api/settings", (req, res) => {
  res.json({ model: currentModel, models: AVAILABLE_MODELS, stageProbabilities, staleDays, autoFollowupEnabled, winbackEnabled });
});

// Einstellungen speichern (KI-Modell und/oder Abschlusswahrscheinlichkeiten).
app.put("/api/settings", wrap(async (req, res) => {
  if (req.body.model !== undefined) {
    const model = typeof req.body.model === "string" ? req.body.model.trim() : "";
    if (!isValidModel(model)) {
      return res.status(400).json({ error: "Unbekanntes Modell." });
    }
    await db.setSetting(MODEL_SETTING_KEY, model);
    currentModel = model;
  }
  if (req.body.stageProbabilities !== undefined) {
    stageProbabilities = sanitizeStageProbabilities(req.body.stageProbabilities);
    await db.setSetting(STAGE_PROB_SETTING_KEY, JSON.stringify(stageProbabilities));
  }
  if (req.body.staleDays !== undefined) {
    staleDays = sanitizeStaleDays(req.body.staleDays);
    await db.setSetting(STALE_DAYS_SETTING_KEY, String(staleDays));
  }
  if (req.body.autoFollowupEnabled !== undefined) {
    autoFollowupEnabled = !!req.body.autoFollowupEnabled;
    await db.setSetting(AUTO_FOLLOWUP_ENABLED_SETTING_KEY, autoFollowupEnabled ? "1" : "0");
  }
  if (req.body.winbackEnabled !== undefined) {
    winbackEnabled = !!req.body.winbackEnabled;
    await db.setSetting(WINBACK_ENABLED_SETTING_KEY, winbackEnabled ? "1" : "0");
  }
  res.json({ model: currentModel, models: AVAILABLE_MODELS, stageProbabilities, staleDays, autoFollowupEnabled, winbackEnabled });
}));

// Alle offenen Wiedervorlagen (ein Termin je Wiedervorlage) in den CalDAV-
// Kalender übertragen – Backfill nach dem Einrichten bzw. manuelle
// Resynchronisation aus den Einstellungen. Räumt zugleich evtl. noch vorhandene
// Legacy-Termine (ein-Termin-je-Lead) auf. Meldet einen Verbindungsfehler
// (z. B. HTTP 401/404) direkt zurück, damit er in der UI sichtbar wird.
app.post("/api/caldav/sync-all", wrap(async (req, res) => {
  if (!caldav.isEnabled()) {
    return res.status(400).json({ error: "Kalender (CalDAV) ist nicht konfiguriert." });
  }
  // Legacy-Termine (ein-Termin-je-Lead aus der Zeit vor der Umstellung) entfernen.
  const leads = await db.listLeads();
  for (const l of leads) await caldav.removeLead(l.id); // best effort, 404 = ok
  // Offene Wiedervorlagen samt Lead-Anzeigedaten neu schreiben.
  const items = await db.listOpenFollowUpsWithLead();
  const result = await caldav.syncAll(items, reqBaseUrl(req));
  if (result.error) {
    return res.status(502).json({ error: `Kalender-Fehler: ${result.error}`, ...result });
  }
  res.json(result);
}));

// Tag-Farbe setzen/ändern (global, case-insensitiv pro Tag-Name). Wird vom
// Inline-Tag-Editor der Detailansicht aufgerufen.
app.put("/api/tags/color", wrap(async (req, res) => {
  const tag = typeof req.body.tag === "string" ? req.body.tag.trim().toLowerCase().slice(0, 40) : "";
  const color = req.body.color;
  if (!tag || !isHexColor(color)) {
    return res.status(400).json({ error: "Ungültiger Tag oder Farbwert (#RRGGBB erwartet)." });
  }
  tagColors = { ...tagColors, [tag]: String(color).toLowerCase() };
  const keys = Object.keys(tagColors);
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete tagColors[k];
  await db.setSetting(TAG_COLORS_SETTING_KEY, JSON.stringify(tagColors));
  res.json({ tagColors });
}));

// --- Editierbare KI-Prompts ------------------------------------------------
// Alle im Programm verwendeten Prompts inkl. Default, aktuellem Wert und
// Platzhaltern – Grundlage der Prompts-Editor-Seite (Einstellungen → Prompts).
app.get("/api/prompts", (req, res) => {
  res.json({ prompts: prompts.list() });
});

// Prompt-Anpassungen speichern. Body: { prompts: { key: text, ... } } – kann
// auch nur einzelne Prompts enthalten (Teil-Update). Werte gleich dem Default
// gelten als „nicht angepasst"; nur echte Abweichungen werden persistiert.
app.put("/api/prompts", wrap(async (req, res) => {
  const incoming = req.body && req.body.prompts;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return res.status(400).json({ error: "Erwartet { prompts: { key: text } }." });
  }
  // Eingehende über die bestehenden Anpassungen legen, damit ein Teil-Update die
  // übrigen nicht verwirft. setOverrides verwirft alles, was dem Default gleicht.
  let current = {};
  try { current = JSON.parse(prompts.serialize()) || {}; } catch { current = {}; }
  const merged = { ...current };
  for (const [k, v] of Object.entries(incoming)) {
    if (prompts.isKnown(k) && typeof v === "string") merged[k] = v;
  }
  prompts.setOverrides(merged);
  await db.setSetting(PROMPTS_SETTING_KEY, prompts.serialize());
  res.json({ prompts: prompts.list() });
}));

// Liste aller Leads
app.get("/api/leads", wrap(async (req, res) => {
  res.json(await db.listLeads());
}));

// Statistiken für das Dashboard
app.get("/api/stats", wrap(async (req, res) => {
  res.json(await db.getStats(STATUSES, stageProbabilities));
}));

// Kompakte, flache Kennzahlen für externe Dashboard-Widgets (z. B. gethomepage.dev).
// Liefert nur einfache Zahlen, damit das Custom-API-Widget sie direkt mappen kann.
app.get("/api/widget", wrap(async (req, res) => {
  res.json(await db.getWidgetStats(STATUSES, stageProbabilities));
}));

// Dateinamen-Datum (YYYY-MM-DD) für Downloads.
function ymd() {
  return new Date().toISOString().slice(0, 10);
}

// CSV-Export aller Leads. Mit UTF-8-BOM, damit Excel Umlaute korrekt anzeigt.
app.get("/api/leads/export.csv", wrap(async (req, res) => {
  const leads = await db.listLeads();
  const csv = leadsToCsv(leads);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads-${ymd()}.csv"`);
  res.send("﻿" + csv);
}));

// Excel-Export aller Leads (SpreadsheetML, von Excel/LibreOffice direkt lesbar).
app.get("/api/leads/export.xlsx", wrap(async (req, res) => {
  const leads = await db.listLeads();
  const xml = leadsToXlsxXml(leads);
  res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads-${ymd()}.xls"`);
  res.send(xml);
}));

// CSV-Import: legt aus einer hochgeladenen CSV neue Leads an. Mögliche Dubletten
// (gleiche E-Mail oder Firma) werden übersprungen, sofern nicht force=true.
app.post("/api/leads/import", wrap(async (req, res) => {
  const text = typeof req.body.csv === "string" ? req.body.csv : "";
  if (!text.trim()) {
    return res.status(400).json({ error: "Keine CSV-Daten erhalten." });
  }
  const force = Boolean(req.body.force);
  const { leads: rows, recognized } = csvRowsToLeads(parseCsv(text));
  if (!recognized.length) {
    return res.status(400).json({
      error: "Keine bekannten Spalten gefunden. Erwartet werden u. a. Name, Firma, E-Mail, Telefon, Quelle, Status, Wert.",
    });
  }

  let created = 0;
  let enriched = 0;
  let skippedDuplicate = 0;
  let skippedEmpty = 0;
  const errors = [];

  for (let idx = 0; idx < rows.length; idx++) {
    const raw = rows[idx];
    try {
      const data = sanitizeLead({ ...raw, value: parseNumber(raw.value) });
      if (!data.name && !data.company) { skippedEmpty++; continue; }
      // KI-Bewertung und Dossier aus den JSON-Spalten übernehmen (falls vorhanden),
      // damit ein Export→Import-Durchlauf diese Daten erhält.
      const research = parseJsonObject(raw.researchJson);
      const ai = parseJsonObject(raw.aiJson);

      if (!force) {
        const dup = await db.findDuplicateLeads({ email: data.email, company: data.company });
        if (dup.length) {
          // Dublette: kein zweiter Datensatz, aber fehlende Angaben ergänzen.
          const filled = await enrichLead(dup[0], data, ai, research, req);
          if (filled.length) enriched++; else skippedDuplicate++;
          continue;
        }
      }

      const lead = await db.createLead(data, research);
      if (ai) await db.setLeadAi(lead.id, ai);
      await logActivity(lead.id, { type: "system", title: "Per CSV-Import angelegt" }, actor(req));
      await reconcileLeadFollowUps(lead, null, reqBaseUrl(req)); // Wiedervorlage in Tabelle/Kalender übernehmen (best effort)
      created++;
    } catch (err) {
      errors.push({ row: idx + 2, error: err.message }); // +2: Kopfzeile + 1-basiert
    }
  }

  res.json({ created, enriched, skippedDuplicate, skippedEmpty, errors, recognized, total: rows.length });
}));

// Lead anlegen
app.post("/api/leads", wrap(async (req, res) => {
  const data = sanitizeLead(req.body);
  if (!data.name && !data.company) {
    return res.status(400).json({ error: "Name oder Firma ist erforderlich." });
  }
  // Dublettenprüfung: bei Treffer warnen (außer der Nutzer erzwingt das Anlegen).
  if (!req.body.force) {
    const duplicates = await db.findDuplicateLeads({ email: data.email, company: data.company });
    if (duplicates.length) {
      return res.status(409).json({ error: "Möglicher Doppeleintrag.", duplicates });
    }
  }
  const lead = await db.createLead(data);
  await logActivity(lead.id, { type: "system", title: "Lead manuell angelegt" }, actor(req));
  await reconcileLeadFollowUps(lead, null, reqBaseUrl(req)); // Wiedervorlage in Tabelle/Kalender (best effort)
  res.status(201).json(lead);
}));

// Ermittelt nach erfolgreicher Recherche automatisch den KI-Score und meldet
// den Fortschritt. Ein Scoring-Fehler darf die Recherche nicht scheitern lassen.
async function scoreAfterResearch(lead, onProgress) {
  if (!lead) return lead;
  try {
    onProgress("⚡ Ermittle KI-Score & Wertschätzung…");
    const { lead: updated, ai } = await applyScore(lead);
    const wert = ai.value > 0 ? ` · geschätzter Wert ${ai.value.toLocaleString("de-DE")} €` : "";
    onProgress(`✅ KI-Score: ${ai.score}/100 (Note ${ai.grade})${wert}`);
    await logActivity(lead.id, {
      type: "ai",
      title: `KI-Score: ${ai.score}/100 (Note ${ai.grade})`,
      body: ai.reasoning || "",
    }, "KI");
    return updated;
  } catch (err) {
    logger.error("auto_score_failed", { error: err.message });
    onProgress("⚠️ KI-Score konnte nicht ermittelt werden (später nachholbar).");
    return lead;
  }
}

// Lead per Recherche anlegen: Eingabe = Firmenname ODER Website-URL.
// Startet einen Hintergrund-Job und liefert sofort eine Job-ID zurück.
app.post("/api/leads/research", aiLimiter, wrap(async (req, res) => {
  if (!requireAi(res)) return;
  if (!allowNewResearch(res)) return;
  const input = typeof req.body.input === "string" ? req.body.input.trim() : "";
  if (!input) {
    return res.status(400).json({ error: "Firmenname oder Website-URL ist erforderlich." });
  }
  const job = startResearchJob(async (onProgress, signal) => {
    const research = await researchCompany(anthropic, input, currentModel, onProgress, signal,
      (u) => recordClaudeUsage(u.model, u.kind, u.usage));
    const data = { ...leadFromResearch(research, input), status: "neu", value: 0, notes: "" };
    const lead = await db.createLead(data, research);
    await logActivity(lead.id, { type: "system", title: "Per Recherche angelegt", body: `Input: ${input}` }, "KI-Recherche");
    await db.recordEvent("research", 1); // verlustfreie Zählung (überlebt Lead-Löschung)
    return scoreAfterResearch(lead, onProgress);
  });
  res.status(202).json({ jobId: job.id });
}));

// Bestehenden Lead neu recherchieren (Daten aktualisieren) – ebenfalls als Job.
app.post("/api/leads/:id/research", aiLimiter, wrap(async (req, res) => {
  if (!requireAi(res)) return;
  if (!allowNewResearch(res)) return;
  const lead = await db.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead nicht gefunden." });
  const input =
    (typeof req.body.input === "string" && req.body.input.trim()) ||
    (lead.research && lead.research.input) ||
    lead.company ||
    lead.source;
  if (!input) {
    return res.status(400).json({ error: "Kein Recherche-Input vorhanden." });
  }
  const job = startResearchJob(async (onProgress, signal) => {
    const research = await researchCompany(anthropic, input, currentModel, onProgress, signal,
      (u) => recordClaudeUsage(u.model, u.kind, u.usage));
    const data = leadFromResearch(research, input);
    const updated = await db.setLeadResearch(lead.id, research, data);
    await logActivity(lead.id, { type: "system", title: "Recherche aktualisiert", body: `Input: ${input}` }, "KI-Recherche");
    await db.recordEvent("research", 1); // verlustfreie Zählung (überlebt Lead-Löschung)
    return scoreAfterResearch(updated, onProgress);
  });
  res.status(202).json({ jobId: job.id });
}));

// Status + Fortschritt eines Recherche-Jobs abfragen (Polling).
app.get("/api/research/:jobId", (req, res) => {
  const job = researchJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Recherche-Job nicht gefunden." });
  res.json({ status: job.status, steps: job.steps, lead: job.lead, result: job.result, kind: job.kind, error: job.error });
});

// Laufende Recherche abbrechen (bricht den KI-Stream via AbortController ab).
app.post("/api/research/:jobId/cancel", (req, res) => {
  const job = researchJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Recherche-Job nicht gefunden." });
  if (job.status === "running") {
    job.status = "cancelled";
    try { job.controller.abort(); } catch (err) { /* ignore */ }
  }
  res.json({ status: job.status });
});

// Lead-Discovery: findet anhand von Kriterien reale Unternehmen und legt sie als
// (deduplizierte) Prospects an. Läuft als Hintergrund-Job; das Ergebnis ist eine
// Zusammenfassung { added, skippedDuplicate, total }, gepollt per /api/research/:jobId.
app.post("/api/discovery", aiLimiter, wrap(async (req, res) => {
  if (!requireAi(res)) return;
  if (!allowNewResearch(res)) return;
  const b = req.body || {};
  const clean = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const criteria = {
    branche: clean(b.branche),
    region: clean(b.region),
    groesse: clean(b.groesse),
    stichworte: clean(b.stichworte),
    freitext: clean(b.freitext, 500),
    anzahl: Math.max(1, Math.min(25, Math.round(Number(b.anzahl) || 10))),
  };
  if (!criteria.branche && !criteria.region && !criteria.stichworte && !criteria.freitext) {
    return res.status(400).json({ error: "Bitte mindestens ein Kriterium angeben (Branche, Region oder Stichworte)." });
  }
  const job = startResearchJob(async (onProgress, signal) => {
    const result = await discoverCompanies(anthropic, criteria, currentModel, onProgress, signal,
      (u) => recordClaudeUsage(u.model, u.kind, u.usage));
    const cands = Array.isArray(result.kandidaten) ? result.kandidaten : [];
    // Treffer dedupliziert als Prospects anlegen (Dedup gegen Prospects + Leads).
    let added = 0, skippedDuplicate = 0;
    for (const c of cands) {
      const prospect = await db.createProspect({
        name: c.name,
        website: c.website && c.website !== "k.A." ? c.website : "",
        ort: c.ort, branche: c.branche, groesse: c.groesse,
        potenzial: c.potenzial, potenzialGrund: c.potenzialGrund,
        begruendung: c.begruendung, quelle: c.quelle, kriterien: criteria,
      });
      if (prospect) added++; else skippedDuplicate++;
    }
    await db.recordEvent("discovery", added); // verlustfreie Zählung entdeckter Leads
    onProgress(`✅ ${added} neue Prospects · ${skippedDuplicate} Dublette(n) übersprungen`);
    return { added, skippedDuplicate, total: cands.length };
  }, "discovery");
  res.status(202).json({ jobId: job.id });
}));

// --- Prospects (Discovery-Liste) -------------------------------------------
// Alle Prospects (Frontend filtert nach Status: offen/abgelehnt).
app.get("/api/prospects", wrap(async (req, res) => {
  res.json(await db.listProspects());
}));

// CSV-Export aller Prospects (offen + abgelehnt; die Status-Spalte
// unterscheidet sie). Mit UTF-8-BOM, damit Excel Umlaute korrekt anzeigt.
app.get("/api/prospects/export.csv", wrap(async (req, res) => {
  const prospects = await db.listProspects();
  const csv = prospectsToCsv(prospects);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="prospects-${ymd()}.csv"`);
  res.send("﻿" + csv);
}));

// CSV-Import: legt aus einer hochgeladenen CSV neue Prospects an. Dubletten
// (gegen vorhandene Prospects inkl. 'abgelehnt' UND Leads) werden übersprungen –
// anders als beim Lead-Import gibt es keine Ergänzung bestehender Datensätze.
app.post("/api/prospects/import", wrap(async (req, res) => {
  const text = typeof req.body.csv === "string" ? req.body.csv : "";
  if (!text.trim()) {
    return res.status(400).json({ error: "Keine CSV-Daten erhalten." });
  }
  const { prospects: rows, recognized } = csvRowsToProspects(parseCsv(text));
  if (!recognized.length) {
    return res.status(400).json({
      error: "Keine bekannten Spalten gefunden. Erwartet werden u. a. Name, Website, Ort, Branche, Größe, Potenzial, Status.",
    });
  }

  let created = 0;
  let skippedDuplicate = 0;
  let skippedEmpty = 0;
  const errors = [];

  for (let idx = 0; idx < rows.length; idx++) {
    try {
      const data = sanitizeProspect(rows[idx]);
      if (!data.name && !data.website && !data.domain) { skippedEmpty++; continue; }
      const prospect = await db.createProspect(data);
      if (prospect) created++; else skippedDuplicate++;
    } catch (err) {
      errors.push({ row: idx + 2, error: err.message }); // +2: Kopfzeile + 1-basiert
    }
  }

  res.json({ created, skippedDuplicate, skippedEmpty, errors, recognized, total: rows.length });
}));

// Status setzen: verwerfen ('abgelehnt', bleibt für Dedup erhalten) oder
// wiederherstellen ('offen').
app.put("/api/prospects/:id", wrap(async (req, res) => {
  const status = req.body && req.body.status === "abgelehnt" ? "abgelehnt" : "offen";
  const prospect = await db.setProspectStatus(req.params.id, status);
  if (!prospect) return res.status(404).json({ error: "Prospect nicht gefunden." });
  res.json(prospect);
}));

// Endgültige Löschung (DSGVO) – entfernt den Prospect vollständig.
app.delete("/api/prospects/:id", wrap(async (req, res) => {
  const ok = await db.deleteProspect(req.params.id);
  if (!ok) return res.status(404).json({ error: "Prospect nicht gefunden." });
  res.status(204).end();
}));

// Prospect recherchieren → vollwertigen Lead anlegen (wie /api/leads/research)
// und den Prospect anschließend aus der Liste entfernen (er ist jetzt Lead).
app.post("/api/prospects/:id/research", aiLimiter, wrap(async (req, res) => {
  if (!requireAi(res)) return;
  if (!allowNewResearch(res)) return;
  const prospect = await db.getProspect(req.params.id);
  if (!prospect) return res.status(404).json({ error: "Prospect nicht gefunden." });
  const input = (prospect.website && prospect.website.trim()) || prospect.name;
  if (!input) return res.status(400).json({ error: "Kein Recherche-Input vorhanden." });
  const job = startResearchJob(async (onProgress, signal) => {
    const research = await researchCompany(anthropic, input, currentModel, onProgress, signal,
      (u) => recordClaudeUsage(u.model, u.kind, u.usage));
    const data = { ...leadFromResearch(research, input), status: "neu", value: 0, notes: "" };
    const lead = await db.createLead(data, research);
    await logActivity(lead.id, { type: "system", title: "Aus Prospect recherchiert", body: `Input: ${input}` }, "KI-Recherche");
    await db.recordEvent("research", 1); // Prospect→Lead-Konvertierung = Recherche → Kosten, mitzählen
    const scored = await scoreAfterResearch(lead, onProgress);
    await db.deleteProspect(prospect.id); // wird zum Lead → aus Prospect-Liste entfernen
    return scored;
  });
  res.status(202).json({ jobId: job.id });
}));

// Recherche-Dossier manuell bearbeiten (ohne KI neu zu starten).
app.put("/api/leads/:id/research", wrap(async (req, res) => {
  const existing = await db.getLead(req.params.id);
  if (!existing) return res.status(404).json({ error: "Lead nicht gefunden." });
  const research = sanitizeResearch(req.body, existing.research || {});
  const lead = await db.updateLeadResearch(req.params.id, research);
  res.json(lead);
}));

// Lead aktualisieren
app.put("/api/leads/:id", wrap(async (req, res) => {
  const existing = await db.getLead(req.params.id);
  if (!existing) return res.status(404).json({ error: "Lead nicht gefunden." });
  const data = sanitizeLead({ ...existing, ...req.body });
  let lead = await db.updateLead(req.params.id, data);
  // Manuelle Wiedervorlage aus dem Spiegel nur dann reconcilen, wenn die
  // Schritt-Felder tatsächlich verändert wurden (Legacy-Modal/Formular). Ein
  // reiner Status-PUT trägt den abgeleiteten Spiegel (evtl. eine AUTO-Wieder-
  // vorlage) nur durch – daraus darf keine manuelle Dublette entstehen.
  const stepChanged =
    data.nextStep !== existing.nextStep ||
    (data.nextStepAt || null) !== (existing.nextStepAt || null);
  const shim = stepChanged
    ? await db.upsertManualFollowUpFromMirror(lead.id)
    : { upserted: null, dismissed: [] };
  if (existing.status !== lead.status) {
    const reasonKey = lead.status === "verloren" ? sanitizeLossReason(req.body.lossReason) : null;
    const reasonLabel = reasonKey ? (LOSS_REASONS.find((r) => r.key === reasonKey) || {}).label : null;
    await logActivity(lead.id, {
      type: "status",
      title: `Status: ${existing.status} → ${lead.status}${reasonLabel ? ` · Grund: ${reasonLabel}` : ""}`,
    }, actor(req));
  }
  // Übergang nach 'gewonnen': Abschlusszeitpunkt verankern und automatische
  // After-Sales-Wiedervorlagen (Referenz/Jubiläum) anlegen.
  if (lead.status === "gewonnen" && existing.status !== "gewonnen") {
    lead = (await db.markWon(lead.id)) || lead;
    await applyAutoFollowUps(lead, existing.status);
  }
  // Übergang nach 'verloren': Verlustgrund + Zeitpunkt verankern und – je nach
  // Grund – eine zukünftige Win-back-Wiedervorlage anlegen.
  if (lead.status === "verloren" && existing.status !== "verloren") {
    lead = (await db.markLost(lead.id, sanitizeLossReason(req.body.lossReason))) || lead;
    await applyWinBackFollowUp(lead, existing.status);
  } else if (lead.status === "verloren" && req.body.lossReason !== undefined) {
    // Bereits verloren – Grund nachträglich geändert: nur den Grund aktualisieren
    // (kein erneutes Win-back beim reinen Bearbeiten).
    lead = (await db.markLost(lead.id, sanitizeLossReason(req.body.lossReason))) || lead;
  }
  // Kalender (best effort): erledigte manuelle Termine entfernen, alle offenen
  // Wiedervorlagen-Termine anlegen/auffrischen (ein Termin je Wiedervorlage).
  if (caldav.isEnabled()) {
    for (const fu of shim.dismissed) caldav.removeFollowUp(fu.id);
    const newlyId = shim.upserted && shim.upserted.id;
    for (const fu of await db.listFollowUps(lead.id)) {
      if (fu.status !== "open") continue;
      const prev = fu.id === newlyId ? null : { lead: existing, followUp: fu };
      caldav.syncFollowUp(lead, fu, prev, reqBaseUrl(req));
    }
  }
  // Aktuellen Stand zurückgeben (Spiegel evtl. neu abgeleitet, won_at gesetzt).
  res.json((await db.getLead(lead.id)) || lead);
}));

// DSGVO-Datenauskunft: alle zu einem Lead gespeicherten Daten (Stammdaten +
// Aktivitäten) als JSON – erfüllt Auskunft (Art. 15) und Übertragbarkeit (Art. 20).
app.get("/api/leads/:id/export", wrap(async (req, res) => {
  const lead = await db.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead nicht gefunden." });
  const activities = await db.listActivities(lead.id);
  res.json({ exportedAt: new Date().toISOString(), lead, activities });
}));

// Lead löschen
app.delete("/api/leads/:id", wrap(async (req, res) => {
  // Follow-up-IDs vor dem Löschen merken (ON DELETE CASCADE entfernt die Zeilen),
  // um die zugehörigen Kalender-Termine aufzuräumen.
  const followUps = await db.listFollowUps(req.params.id);
  const ok = await db.deleteLead(req.params.id);
  if (!ok) return res.status(404).json({ error: "Lead nicht gefunden." });
  for (const fu of followUps) caldav.removeFollowUp(fu.id); // best effort
  caldav.removeLead(req.params.id); // evtl. noch vorhandener Legacy-Termin
  res.status(204).end();
}));

// --- KI-Endpunkte ----------------------------------------------------------
function leadContext(lead) {
  const base = [
    `Firma: ${lead.company || "—"}`,
    `Ansprechpartner: ${lead.name || "—"}`,
    `E-Mail: ${lead.email || "—"}`,
    `Telefon: ${lead.phone || "—"}`,
    `Quelle: ${lead.source || "—"}`,
    `Status: ${lead.status}`,
    `Geschätzter Wert: ${lead.value} €`,
    `Notizen: ${lead.notes || "—"}`,
  ];

  // Wenn ein Recherche-Dossier vorliegt, hängen wir es vollständig an – die
  // KI-Funktionen (Scoring, E-Mail, Tipps) bauen dann darauf auf.
  if (lead.research) {
    const r = lead.research;
    const f = r.fields || {};
    const fv = (x) => (x && x.value) || "—";
    base.push(
      "",
      "── Recherche-Dossier (FU/GE Cold-Call-Vorbereitung) ──",
      `Branche: ${fv(f.branche)}`,
      `Adresse: ${fv(f.adresse)}`,
      `Öffnungszeiten: ${fv(f.oeffnungszeiten)}`,
      `Kundenbewertung: ${fv(f.kundenbewertung)}`,
      `Negative Bewertungen: ${r.negativeBewertungen || "—"}`,
      `Einordnung/Selbstdarstellung: ${r.einordnung || "—"}`,
      `Eingesetzte Systeme (Integrations-Andockpunkte): ${r.eingesetzteSysteme || "—"}`,
      `Sichtbare Schwachstellen: ${r.schwachstellen || "—"}`,
      "Potenziale für FU/GE:",
      ...(Array.isArray(r.potenziale) && r.potenziale.length
        ? r.potenziale.map((p) => `  • ${p.titel}: ${p.beschreibung} (Signal: ${p.signal})`)
        : ["  —"]),
      `Cold-Call-Strategie: ${r.coldCallStrategie || "—"}`,
      `Risiken / Ablehnungsgründe: ${r.risiken || "—"}`,
    );
  }

  return base.join("\n");
}

// Anthropic-Listenpreise in USD pro 1 Mio. Tokens (Quelle: platform.claude.com).
// Cache-Writes kosten das 1,25-fache, Cache-Reads das 0,1-fache des Input-Preises.
const MODEL_PRICING = {
  "claude-opus-4-8":   { input: 5.0, output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5":  { input: 1.0, output: 5.0 },
};
// Server-Tool-Gebühren: Web-Suche $10 pro 1.000 Anfragen. (Web-Fetch kostet
// nichts extra; dessen Inhalt zählt bereits als Input-Tokens.)
const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;

// Errechnet die Kosten eines Aufrufs aus dem usage-Objekt (Tokens + Tool-
// Gebühren) und schreibt sie weg. Schlägt nie hart fehl – Kostenerfassung darf
// den Hauptablauf nicht stören.
async function recordClaudeUsage(model, kind, usage) {
  try {
    if (!usage) return;
    const inp = Number(usage.input_tokens) || 0;
    const out = Number(usage.output_tokens) || 0;
    const cw = Number(usage.cache_creation_input_tokens) || 0;
    const cr = Number(usage.cache_read_input_tokens) || 0;
    const webSearches = (usage.server_tool_use && Number(usage.server_tool_use.web_search_requests)) || 0;

    let costUsd = webSearches * WEB_SEARCH_USD_PER_REQUEST; // Tool-Gebühren immer
    const p = MODEL_PRICING[model];
    if (p) {
      costUsd += (inp * p.input + out * p.output + cw * p.input * 1.25 + cr * p.input * 0.1) / 1e6;
    }
    await db.recordUsage({
      model, kind,
      inputTokens: inp, outputTokens: out,
      cacheWriteTokens: cw, cacheReadTokens: cr,
      webSearches,
      costUsd,
    });
  } catch (err) {
    logger.warn("usage_record_failed", { model, kind, error: err.message });
  }
}

// Optional ein eigenes `schema` übergeben, um die JSON-Ausgabe für andere
// KI-Funktionen zu erzwingen; ohne Angabe gilt das eingebaute Score-Schema.
async function callClaude(system, userText, { json = false, kind = "ai", schema = null, maxTokens = 1500 } = {}) {
  const params = {
    model: currentModel,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userText }],
  };
  if (json) {
    params.output_config = {
      format: {
        type: "json_schema",
        schema: schema || {
          type: "object",
          properties: {
            score: { type: "integer", description: "0 (kalt) bis 100 (sehr heiß)." },
            grade: { type: "string", enum: ["A", "B", "C", "D"] },
            reasoning: {
              type: "string",
              description:
                "Knappe Begründung des Scores: 1–2 kurze Sätze, max. ~240 Zeichen. KEINE Handlungsempfehlung oder Cold-Call-Strategie (steht bereits im Dossier).",
            },
            value: {
              type: "integer",
              description:
                "Geschätzter Auftragswert in EUR auf 12-Monats-Basis: Einmalprojekt = Projektwert; laufende/SaaS-Erlöse (z. B. TelKI) = Summe der ersten 12 Monate. 0, wenn nicht seriös schätzbar.",
            },
            valueReasoning: {
              type: "string",
              description: "Sehr kurze Begründung der 12-Monats-Wertschätzung (1 Satz).",
            },
          },
          required: ["score", "grade", "reasoning", "value", "valueReasoning"],
          additionalProperties: false,
        },
      },
    };
  }
  const msg = await anthropic.messages.create(params);
  await recordClaudeUsage(currentModel, kind, msg.usage);
  const text = msg.content.find((b) => b.type === "text");
  return text ? text.text : "";
}

function requireAi(res) {
  if (!aiEnabled()) {
    res.status(503).json({ error: "KI ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt)." });
    return false;
  }
  return true;
}

// Ermittelt KI-Score UND eine Wertschätzung für einen Lead. Liefert das
// ai-Objekt plus den geschätzten Wert. Wird vom Score-Endpoint und automatisch
// nach jeder Recherche genutzt.
async function computeLeadScore(lead) {
  const raw = await callClaude(
    prompts.get("score.system"),
    prompts.render("score.user", { leadContext: leadContext(lead) }),
    { json: true, kind: "score" }
  );
  const result = JSON.parse(raw);
  let value = Math.round(Number(result.value));
  if (!Number.isFinite(value) || value < 0) value = 0;
  return {
    score: Math.max(0, Math.min(100, Number(result.score) || 0)),
    grade: result.grade || "C",
    reasoning: result.reasoning || "",
    value,
    valueReasoning: result.valueReasoning || "",
    scoredAt: new Date().toISOString(),
  };
}

// Persistiert Score + Wertschätzung. Der geschätzte Wert wird nur übernommen,
// wenn noch kein Wert manuell gepflegt wurde (überschreibt nichts).
async function applyScore(lead) {
  const r = await computeLeadScore(lead);
  const ai = {
    score: r.score, grade: r.grade, reasoning: r.reasoning,
    valueReasoning: r.valueReasoning, scoredAt: r.scoredAt,
  };
  let updated = await db.setLeadAi(lead.id, ai);
  if (r.value > 0 && (!lead.value || Number(lead.value) === 0)) {
    updated = await db.updateLead(lead.id, sanitizeLead({ ...(updated || lead), value: r.value }));
  }
  return { lead: updated || lead, ai: r };
}

// KI-Bewertung / Lead-Scoring
app.post("/api/leads/:id/score", aiLimiter, wrap(async (req, res) => {
  if (!requireAi(res)) return;
  const lead = await db.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead nicht gefunden." });
  try {
    const { lead: updated, ai } = await applyScore(lead);
    await logActivity(lead.id, {
      type: "ai",
      title: `KI-Score: ${ai.score}/100 (Note ${ai.grade})`,
      body: ai.reasoning || "",
    }, actor(req));
    res.json(updated);
  } catch (err) {
    (req.log || logger).error("scoring_failed", { leadId: req.params.id, error: err.message });
    res.status(502).json({ error: "KI-Bewertung fehlgeschlagen. Bitte erneut versuchen." });
  }
}));

// KI-E-Mail-Entwurf
app.post("/api/leads/:id/email", aiLimiter, wrap(async (req, res) => {
  if (!requireAi(res)) return;
  const lead = await db.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead nicht gefunden." });
  const goal =
    typeof req.body.goal === "string" && req.body.goal.trim()
      ? req.body.goal.trim()
      : "Erstkontakt herstellen und ein kurzes Kennenlerngespräch vorschlagen";
  try {
    const text = await callClaude(
      prompts.get("email.system"),
      prompts.render("email.user", { goal, leadContext: leadContext(lead) }),
      { kind: "email" }
    );
    await logActivity(lead.id, { type: "email", title: "KI-E-Mail-Entwurf erstellt", body: text }, actor(req));
    res.json({ email: text });
  } catch (err) {
    (req.log || logger).error("email_failed", { leadId: req.params.id, error: err.message });
    res.status(502).json({ error: "E-Mail-Entwurf fehlgeschlagen. Bitte erneut versuchen." });
  }
}));

// KI-Empfehlung / Next Best Action
app.post("/api/leads/:id/insights", aiLimiter, wrap(async (req, res) => {
  if (!requireAi(res)) return;
  const lead = await db.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead nicht gefunden." });
  try {
    const text = await callClaude(
      prompts.get("insights.system"),
      prompts.render("insights.user", { leadContext: leadContext(lead) }),
      { kind: "insight" }
    );
    await logActivity(lead.id, { type: "ai", title: "KI-Empfehlung erstellt", body: text }, actor(req));
    res.json({ insights: text });
  } catch (err) {
    (req.log || logger).error("insights_failed", { leadId: req.params.id, error: err.message });
    res.status(502).json({ error: "Empfehlung fehlgeschlagen. Bitte erneut versuchen." });
  }
}));

// --- KI-Tagesempfehlung („Heute"-Seite) ------------------------------------
// Empfiehlt die nächsten Handlungen über alle offenen Leads hinweg – dieselben
// Signale wie die „Heute"-Ansicht: fällige/überfällige Wiedervorlagen, offene
// Leads ohne nächsten Schritt, KI-Score und Stillstand. Read-only: legt keine
// Aktivitäten an und ändert keine Leads.

// Tagesdatum „YYYY-MM-DD". Bevorzugt das vom Client übergebene (lokale) Datum,
// damit die Fälligkeits-Einstufung exakt der „Heute"-Ansicht entspricht; sonst
// die lokale Serverzeit.
function agendaToday(req) {
  const c = req && req.body && req.body.today;
  if (typeof c === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c)) return c;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Ganze Tage seit einem ISO-Zeitpunkt (für „letzte Aktivität vor N Tagen").
function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

// Fälligkeits-Zustand einer Wiedervorlage relativ zu `today`.
function agendaDueState(l, today) {
  if (!l.nextStepAt) return null;
  if (l.nextStepAt < today) return "overdue";
  if (l.nextStepAt === today) return "today";
  return "future";
}

// Wählt die handlungsrelevanten offenen Leads (gespiegelt von der Heute-Logik),
// sortiert nach Dringlichkeit und deckelt die Menge (Token-Last).
function selectAgendaCandidates(leads, today) {
  const open = leads.filter((l) => l.status !== "gewonnen" && l.status !== "verloren");
  // Relevant: alles mit Wiedervorlage + bearbeitete offene Leads ohne Schritt
  // (frische „neu"-Leads bleiben – wie in der Ansicht – außen vor).
  const candidates = open.filter((l) => agendaDueState(l, today) || l.status !== "neu");
  // Priorität für die Auswahl: überfällig → heute → ohne Schritt → demnächst.
  const rank = (l) => {
    const s = agendaDueState(l, today);
    if (s === "overdue") return 0;
    if (s === "today") return 1;
    if (s === "future") return 3;
    return 2;
  };
  candidates.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const ad = a.nextStepAt || "9999-12-31";
    const bd = b.nextStepAt || "9999-12-31";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return ((b.ai && b.ai.score) || 0) - ((a.ai && a.ai.score) || 0);
  });
  return candidates.slice(0, 30);
}

// Whitespace/Zeilenumbrüche zu einer Zeile glätten (Notizen/Aktivitätstexte).
function oneLine(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

// Relatives Tageslabel für Aktivitäten („heute" / „gestern" / „vor N Tg.").
function relDaysLabel(iso) {
  const n = daysSince(iso);
  if (n == null) return "";
  if (n === 0) return "heute";
  if (n === 1) return "gestern";
  return `vor ${n} Tg.`;
}

// Baut aus den (bereits ausgewählten) Kandidaten den kompakten KI-Kontext: je
// Lead die Kernsignale plus Notizen und der bisherige Verlauf (letzte echte
// Aktivitäten) – die Grundlage, um den logischen NÄCHSTEN Schritt abzuleiten.
// `activitiesByLead`: Map leadId -> Aktivitäten (neueste zuerst).
function buildAgendaContext(candidates, today, activitiesByLead = new Map()) {
  const lines = candidates.map((l) => {
    const parts = [`[${l.id}] ${l.company || l.name || "—"}`, `Status: ${l.status}`];
    if (l.value) parts.push(`Wert: ${Math.round(Number(l.value))} €`);
    if (l.ai && l.ai.score != null) parts.push(`Score: ${l.ai.score}/100 (${l.ai.grade || "?"})`);
    const s = agendaDueState(l, today);
    const due =
      s === "overdue" ? `überfällig (war am ${l.nextStepAt})` :
      s === "today" ? "heute fällig" :
      s === "future" ? `geplant am ${l.nextStepAt}` : "keine Wiedervorlage geplant";
    parts.push(`Nächster Schritt: ${l.nextStep || "—"} – ${due}`);
    const since = daysSince(l.lastActivityAt);
    if (since != null) parts.push(`letzte Aktivität vor ${since} Tg.`);
    if (l.research) {
      const r = l.research;
      const hook = (Array.isArray(r.potenziale) && r.potenziale[0] && r.potenziale[0].titel)
        || (typeof r.coldCallStrategie === "string" ? r.coldCallStrategie.slice(0, 140) : "");
      if (hook) parts.push(`Aufhänger: ${hook}`);
    }
    // Notizen und Verlauf als eingerückte Folgezeilen (Grundlage für den
    // nächsten Schritt). Beides knapp gedeckelt, damit der Kontext kompakt bleibt.
    const extra = [];
    const notes = oneLine(l.notes);
    if (notes) extra.push(`  Notizen: ${notes.slice(0, 280)}`);
    const acts = activitiesByLead.get(l.id) || [];
    if (acts.length) {
      const hist = acts.map((a) => {
        const text = oneLine([a.title, a.body].filter(Boolean).join(" – ")).slice(0, 160);
        const oc = oneLine(a.outcome);
        return `${relDaysLabel(a.createdAt)} [${a.type}] ${text}${oc ? ` (${oc.slice(0, 40)})` : ""}`.trim();
      }).join("; ");
      extra.push(`  Verlauf: ${hist}`);
    }
    return ["- " + parts.join(" · "), ...extra].join("\n");
  });

  return { lines, ids: candidates.map((l) => l.id), count: candidates.length };
}

// Schema: bis zu drei priorisierte nächste Handlungen.
const AGENDA_REC_SCHEMA = {
  type: "object",
  properties: {
    recommendations: {
      type: "array",
      description: "Die wichtigsten nächsten Handlungen, höchste Priorität zuerst. Höchstens drei Einträge.",
      items: {
        type: "object",
        properties: {
          leadId: { type: "string", description: "ID des Leads aus der vorgelegten Liste (der Wert in eckigen Klammern). Nur vorhandene IDs verwenden." },
          action: { type: "string", description: "Konkrete, sofort umsetzbare Handlung als kurzer Imperativ (z. B. 'Anrufen und Angebot nachfassen')." },
          reason: { type: "string", description: "Eine kurze Begründung, warum diese Handlung jetzt dran ist (belegtes Signal aus der Liste)." },
          priority: { type: "string", enum: ["hoch", "mittel", "niedrig"] },
        },
        required: ["leadId", "action", "reason", "priority"],
        additionalProperties: false,
      },
    },
  },
  required: ["recommendations"],
  additionalProperties: false,
};

// KI-Tagesempfehlung: die nächsten (bis zu 3) Handlungen über alle offenen Leads.
app.post("/api/agenda/recommendations", aiLimiter, wrap(async (req, res) => {
  if (!requireAi(res)) return;
  const leads = await db.listLeads();
  const today = agendaToday(req);
  const candidates = selectAgendaCandidates(leads, today);
  // Nichts zu tun → ohne KI-Aufruf (und damit ohne Kosten) leer antworten.
  if (!candidates.length) return res.json({ recommendations: [], generatedAt: new Date().toISOString() });
  // Letzte echte Touchpoints je Kandidat (ohne automatische ai/system-Einträge)
  // als Grundlage für den nächsten Schritt – in einer Abfrage. Ein Fehler hier
  // darf die Empfehlung nicht verhindern (dann eben ohne Verlauf).
  let activitiesByLead = new Map();
  try {
    activitiesByLead = await db.listRecentActivitiesForLeads(candidates.map((l) => l.id), 3, ["ai", "system"]);
  } catch (err) {
    (req.log || logger).warn("agenda_activities_load_failed", { error: err.message });
  }
  const ctx = buildAgendaContext(candidates, today, activitiesByLead);
  try {
    const raw = await callClaude(
      prompts.get("agenda.system"),
      prompts.render("agenda.user", { leadList: ctx.lines.join("\n") }),
      { json: true, kind: "agenda-recommendations", schema: AGENDA_REC_SCHEMA, maxTokens: 1200 }
    );
    const parsed = JSON.parse(raw);
    const valid = new Set(ctx.ids);
    const byId = new Map(leads.map((l) => [l.id, l]));
    const seen = new Set();
    const recommendations = [];
    for (const r of (Array.isArray(parsed.recommendations) ? parsed.recommendations : [])) {
      if (!r || !valid.has(r.leadId) || seen.has(r.leadId)) continue;
      seen.add(r.leadId);
      const l = byId.get(r.leadId);
      recommendations.push({
        leadId: r.leadId,
        company: (l && (l.company || l.name)) || "—",
        status: l ? l.status : "",
        nextStepAt: l ? l.nextStepAt : null,
        action: String(r.action || "").trim().slice(0, 300),
        reason: String(r.reason || "").trim().slice(0, 300),
        priority: ["hoch", "mittel", "niedrig"].includes(r.priority) ? r.priority : "mittel",
      });
      if (recommendations.length >= 3) break;
    }
    res.json({ recommendations, generatedAt: new Date().toISOString() });
  } catch (err) {
    (req.log || logger).error("agenda_recommendations_failed", { error: err.message });
    res.status(502).json({ error: "KI-Empfehlung fehlgeschlagen. Bitte erneut versuchen." });
  }
}));

// --- Aktivitäten-Timeline --------------------------------------------------
const ACTIVITY_TYPES = ["note", "call", "email", "meeting", "status", "ai", "system"];

// --- Wiedervorlagen (Follow-ups) -------------------------------------------
function sanitizeFollowUpInput(body = {}) {
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 500) : undefined;
  let dueDate;
  if (body.dueDate !== undefined) {
    const d = typeof body.dueDate === "string" ? body.dueDate.trim() : "";
    dueDate = /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(d).getTime()) ? d : null;
  }
  // Optionale Uhrzeit "HH:MM" (für echte Termine). Ungültig/leer → null.
  let dueTime;
  if (body.dueTime !== undefined) {
    const t = typeof body.dueTime === "string" ? body.dueTime.trim() : "";
    dueTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : null;
  }
  return { title, dueDate, dueTime };
}

// Fällige offene Wiedervorlagen auf geschlossenen Leads (Gruppe „Kundenpflege /
// Referenzen" der „Heute"-Seite). MUSS vor etwaigen /:id-Routen stehen.
app.get("/api/follow-ups/due", wrap(async (req, res) => {
  res.json(await db.getDueFollowUpsForWonLeads());
}));

// Alle Wiedervorlagen eines Leads (offene zuerst).
app.get("/api/leads/:id/follow-ups", wrap(async (req, res) => {
  res.json(await db.listFollowUps(req.params.id));
}));

// Manuelle Wiedervorlage planen.
app.post("/api/leads/:id/follow-ups", wrap(async (req, res) => {
  const lead = await db.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead nicht gefunden." });
  const { title, dueDate, dueTime } = sanitizeFollowUpInput(req.body);
  if (!dueDate) return res.status(400).json({ error: "Gültiges Datum (YYYY-MM-DD) erforderlich." });
  // Ein echter Termin (kind 'appointment') trägt eine Uhrzeit und landet als
  // besetzter Kalendereintrag im CalDAV-Sync; sonst eine reine Wiedervorlage.
  const kind = req.body.kind === "appointment" ? "appointment" : "manual";
  const fu = await db.createFollowUp({
    leadId: lead.id, source: "manual", kind, title: title || "", dueDate, dueTime: dueTime || null,
  });
  await db.syncLeadMirror(lead.id);
  if (kind === "appointment") {
    const [yy, mm, dd] = dueDate.split("-");
    const when = [`${dd}.${mm}.${yy}`, fu.dueTime ? `${fu.dueTime} Uhr` : ""].filter(Boolean).join(" ");
    await logActivity(lead.id, { type: "meeting", title: `Termin vereinbart: ${[fu.title, when].filter(Boolean).join(" – ")}` }, actor(req));
  } else {
    await logActivity(lead.id, { type: "system", title: `Wiedervorlage geplant: ${fu.title || dueDate}` }, actor(req));
  }
  caldav.syncFollowUp(lead, fu, null, reqBaseUrl(req));
  res.status(201).json(fu);
}));

// Wiedervorlage ändern: Status (done/dismissed/open) ODER Titel/Datum (verschieben).
app.patch("/api/follow-ups/:id", wrap(async (req, res) => {
  const existing = await db.getFollowUp(req.params.id);
  if (!existing) return res.status(404).json({ error: "Wiedervorlage nicht gefunden." });
  let fu = existing;
  if (typeof req.body.status === "string") {
    const status = req.body.status.toLowerCase();
    if (!["open", "done", "dismissed"].includes(status)) {
      return res.status(400).json({ error: "Ungültiger Status." });
    }
    fu = await db.setFollowUpStatus(existing.id, status);
    if (status !== "open") {
      await logActivity(existing.leadId,
        { type: "system", title: `Wiedervorlage ${status === "done" ? "erledigt" : "verworfen"}: ${existing.title || existing.dueDate}` },
        actor(req));
    }
  } else {
    const { title, dueDate, dueTime } = sanitizeFollowUpInput(req.body);
    if (req.body.dueDate !== undefined && !dueDate) {
      return res.status(400).json({ error: "Gültiges Datum (YYYY-MM-DD) erforderlich." });
    }
    fu = await db.updateFollowUp(existing.id, { title, dueDate, dueTime });
  }
  await db.syncLeadMirror(existing.leadId);
  const lead = await db.getLead(existing.leadId);
  if (lead) caldav.syncFollowUp(lead, fu, { lead, followUp: existing }, reqBaseUrl(req));
  res.json(fu);
}));

// Aktivitäten eines Leads (chronologisch, neueste zuerst).
app.get("/api/leads/:id/activities", wrap(async (req, res) => {
  res.json(await db.listActivities(req.params.id));
}));

// Aktivität manuell erfassen (Notiz, Anruf, Mail, Termin …).
app.post("/api/leads/:id/activities", wrap(async (req, res) => {
  const lead = await db.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead nicht gefunden." });
  const clean = (v, max = 5000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  let type = clean(req.body.type).toLowerCase();
  if (!ACTIVITY_TYPES.includes(type)) type = "note";
  const title = clean(req.body.title, 500);
  const body = clean(req.body.body, 10000);
  if (!title && !body) {
    return res.status(400).json({ error: "Titel oder Text ist erforderlich." });
  }
  const activity = await db.createActivity({
    leadId: lead.id, type, title, body, outcome: clean(req.body.outcome), actor: actor(req),
  });
  res.status(201).json(activity);
}));

// Aktivität löschen.
app.delete("/api/activities/:id", wrap(async (req, res) => {
  const ok = await db.deleteActivity(req.params.id);
  if (!ok) return res.status(404).json({ error: "Aktivität nicht gefunden." });
  res.status(204).end();
}));

// --- Reporting -------------------------------------------------------------
app.get("/api/report", wrap(async (req, res) => {
  res.json(await db.getReport(STATUSES, stageProbabilities));
}));

// --- Start -----------------------------------------------------------------
db.init()
  .then(async () => {
    // Gespeichertes Modell laden (falls vorhanden und gültig).
    try {
      const saved = await db.getSetting(MODEL_SETTING_KEY);
      if (saved && isValidModel(saved)) currentModel = saved;
    } catch (err) {
      logger.warn("model_setting_load_failed", { error: err.message });
    }
    // Gespeicherte Abschlusswahrscheinlichkeiten laden.
    try {
      const savedProb = await db.getSetting(STAGE_PROB_SETTING_KEY);
      if (savedProb) stageProbabilities = sanitizeStageProbabilities(JSON.parse(savedProb));
    } catch (err) {
      logger.warn("stage_probabilities_load_failed", { error: err.message });
    }
    // Gespeicherte „Kalt"-Schwelle laden.
    try {
      const savedStale = await db.getSetting(STALE_DAYS_SETTING_KEY);
      if (savedStale) staleDays = sanitizeStaleDays(savedStale);
    } catch (err) {
      logger.warn("stale_days_load_failed", { error: err.message });
    }
    // Gespeicherte Tag-Farben laden.
    try {
      const savedTagColors = await db.getSetting(TAG_COLORS_SETTING_KEY);
      if (savedTagColors) tagColors = sanitizeTagColors(JSON.parse(savedTagColors));
    } catch (err) {
      logger.warn("tag_colors_load_failed", { error: err.message });
    }
    // Gespeicherte Prompt-Anpassungen laden (nur Abweichungen vom Default).
    try {
      const savedPrompts = await db.getSetting(PROMPTS_SETTING_KEY);
      if (savedPrompts) prompts.setOverrides(JSON.parse(savedPrompts));
    } catch (err) {
      logger.warn("prompt_overrides_load_failed", { error: err.message });
    }
    // Schalter laden: ob automatische After-Sales-Wiedervorlagen angelegt werden.
    try {
      const v = await db.getSetting(AUTO_FOLLOWUP_ENABLED_SETTING_KEY);
      if (v !== null) autoFollowupEnabled = v === "1";
    } catch (err) {
      logger.warn("auto_followup_enabled_load_failed", { error: err.message });
    }
    // Schalter laden: ob automatische Win-back-Wiedervorlagen angelegt werden.
    try {
      const v = await db.getSetting(WINBACK_ENABLED_SETTING_KEY);
      if (v !== null) winbackEnabled = v === "1";
    } catch (err) {
      logger.warn("winback_enabled_load_failed", { error: err.message });
    }
    // Auto-Wiedervorlagen für bereits gewonnene Leads nachziehen (Altbestand);
    // idempotent, nur zukünftig fällige Regeln. Blockiert den Start nicht.
    backfillAutoFollowUps().catch((err) =>
      logger.warn("auto_followup_backfill_failed", { error: err.message })
    );
    if (usingDefaultDbPassword()) {
      logger.warn("default_db_password", {
        hint: "Das DB-Passwort ist auf den unsicheren Standard 'leadpilot' gesetzt. Bitte POSTGRES_PASSWORD auf ein sicheres Passwort ändern.",
      });
    }
    app.listen(PORT, () => {
      logger.info("server_started", {
        port: PORT,
        aiEnabled: aiEnabled(),
        model: aiEnabled() ? currentModel : null,
        frameAncestors: FRAME_ANCESTORS.length ? FRAME_ANCESTORS.join(" ") : null,
        caldav: caldav.isEnabled() ? caldav.describe() : null,
      });
    });
  })
  .catch((err) => {
    logger.error("startup_failed", { error: err.message });
    process.exit(1);
  });
