"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const db = require("./db");
const { researchCompany, discoverCompanies } = require("./research");
const { leadsToCsv, prospectsToCsv, parseCsv, csvRowsToLeads, csvRowsToProspects, parseNumber, leadsToXlsxXml } = require("./exporters");
const { logger, httpLogger } = require("./logger");
const cfAccess = require("./cfAccess");

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
    model: currentModel,
    models: AVAILABLE_MODELS,
    statuses: STATUSES,
    stageProbabilities,
    staleDays,
    tagColors,
    user: actor(req) !== "—" ? actor(req) : "",
    logoutUrl: LOGOUT_URL,
  });
});

// Einstellungen lesen
app.get("/api/settings", (req, res) => {
  res.json({ model: currentModel, models: AVAILABLE_MODELS, stageProbabilities, staleDays });
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
  res.json({ model: currentModel, models: AVAILABLE_MODELS, stageProbabilities, staleDays });
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
  const lead = await db.updateLead(req.params.id, data);
  if (lead && existing.status !== lead.status) {
    await logActivity(lead.id, {
      type: "status",
      title: `Status: ${existing.status} → ${lead.status}`,
    }, actor(req));
  }
  res.json(lead);
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
  const ok = await db.deleteLead(req.params.id);
  if (!ok) return res.status(404).json({ error: "Lead nicht gefunden." });
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

async function callClaude(system, userText, { json = false, kind = "ai" } = {}) {
  const params = {
    model: currentModel,
    max_tokens: 1500,
    system,
    messages: [{ role: "user", content: userText }],
  };
  if (json) {
    params.output_config = {
      format: {
        type: "json_schema",
        schema: {
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
    "Du bist ein erfahrener B2B-Vertriebsanalyst für FU/GE Solutions (Integration & Entwicklung " +
      "individueller KI-Systeme im Mittelstand/Handwerk). Bewerte knapp Qualität und Abschlusspotenzial eines Leads " +
      "und schätze den realistischen Auftragswert in EUR – immer auf 12-Monats-Basis (Einmalprojekt = Projektwert; " +
      "laufende/SaaS-Erlöse wie TelKI = Summe der ersten 12 Monate). Leite den Wert aus belegten Signalen ab " +
      "(Unternehmensgröße/Standorte/Branche, passende Leistung: Potenzialanalyse, Workshop, KI-Integration oder " +
      "TelKI-SaaS). Sei eher konservativ; wenn keine seriöse Schätzung möglich ist, value=0. " +
      "Fasse dich kurz – KEINE Handlungsempfehlungen oder Cold-Call-Strategie (die stehen bereits im Dossier). " +
      "Antworte ausschließlich im geforderten JSON-Format auf Deutsch.",
    `Bewerte diesen Lead von 0 (kalt) bis 100 (sehr heiß), vergib eine Schulnote A–D und schätze den 12-Monats-Auftragswert.\n\n${leadContext(lead)}`,
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
      "Du bist Vertriebstexter für FU/GE Solutions (Integration & Entwicklung individueller KI-Systeme im Mittelstand/Handwerk). " +
        "Schreibe eine personalisierte, freundliche und prägnante Akquise-E-Mail auf Deutsch. Knüpfe an einen konkreten, " +
        "belegten Ansatzpunkt aus dem Recherche-Dossier an (z. B. eine Schwachstelle oder ein Potenzial). " +
        "Verwende eine klare Betreffzeile (Format: 'Betreff: ...'), eine persönliche Ansprache und einen klaren Call-to-Action. " +
        "Keine Floskeln, kein Spam-Ton, maximal 150 Wörter.",
      `Ziel der E-Mail: ${goal}\n\nLead:\n${leadContext(lead)}`,
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
      "Du bist Vertriebs-Coach für FU/GE Solutions und bereitest Cold Calls vor. Gib eine kurze, konkrete " +
        "Handlungsempfehlung auf Deutsch: 2–4 priorisierte nächste Schritte als Aufzählung, abgeleitet aus den " +
        "belegten Ansatzpunkten und Potenzialen des Recherche-Dossiers. Pragmatisch und umsetzbar.",
      `Was sind die besten nächsten Schritte für diesen Lead?\n\n${leadContext(lead)}`,
      { kind: "insight" }
    );
    await logActivity(lead.id, { type: "ai", title: "KI-Empfehlung erstellt", body: text }, actor(req));
    res.json({ insights: text });
  } catch (err) {
    (req.log || logger).error("insights_failed", { leadId: req.params.id, error: err.message });
    res.status(502).json({ error: "Empfehlung fehlgeschlagen. Bitte erneut versuchen." });
  }
}));

// --- Aktivitäten-Timeline --------------------------------------------------
const ACTIVITY_TYPES = ["note", "call", "email", "meeting", "status", "ai", "system"];

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
      });
    });
  })
  .catch((err) => {
    logger.error("startup_failed", { error: err.message });
    process.exit(1);
  });
