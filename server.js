"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const { researchCompany } = require("./research");
const { logger, httpLogger } = require("./logger");

const PORT = process.env.PORT || 3000;

// Erlaubte Einbettungs-Quellen für den iframe (z. B. Nextcloud „External Sites").
// Kommagetrennte Origin-Liste in FRAME_ANCESTORS, z. B.
//   FRAME_ANCESTORS="https://cloud.firma.de"
// Ohne diese Variable wird kein frame-ancestors-Header gesetzt (Verhalten wie bisher).
const FRAME_ANCESTORS = String(process.env.FRAME_ANCESTORS || "").trim();

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
try {
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require("@anthropic-ai/sdk");
    const { Agent, fetch: undiciFetch } = require("undici");
    // Die agentische Recherche hält lange Streaming-Verbindungen; während der
    // server-seitigen web_search/web_fetch-Schritte fließen teils minutenlang
    // keine Bytes. undicis Default-bodyTimeout (300 s) bricht solche idle
    // Verbindungen sonst ab ("terminated") – genau der ~5-Min-Abbruch, der
    // hinter Proxys/NAT (Cloudflare) auf langsameren Pfaden auftritt.
    const aiDispatcher = new Agent({
      headersTimeout: 600000,                                      // 10 Min bis zum ersten Byte
      bodyTimeout: 0,                                              // kein Idle-Read-Timeout für lange Streams
      connect: { keepAlive: true, keepAliveInitialDelay: 30000 }, // TCP-Keepalive gegen Idle-Drop
    });
    const aiFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: aiDispatcher });
    // maxRetries: das SDK wiederholt 429 (Rate-Limit) automatisch und respektiert
    // dabei den retry-after-Header; auch abgebrochene Verbindungen ("terminated")
    // werden erneut versucht. Default ist 2 – wir erhöhen für die langen,
    // tool-lastigen Recherche-Streams. timeout deckelt einen Einzel-Call.
    anthropic = new Anthropic({ maxRetries: 5, timeout: 900000, fetch: aiFetch });
  }
} catch (err) {
  logger.warn("anthropic_sdk_load_failed", { error: err.message });
}

const aiEnabled = () => Boolean(anthropic);

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

function sanitizeLead(body = {}) {
  const clean = (v) => (typeof v === "string" ? v.trim() : "");
  let status = clean(body.status).toLowerCase();
  if (!STATUSES.includes(status)) status = "neu";
  let value = Number(body.value);
  if (!Number.isFinite(value) || value < 0) value = 0;
  // Wiedervorlage-Datum: ausschließlich YYYY-MM-DD akzeptieren, sonst null.
  let nextStepAt = null;
  const ns = clean(body.nextStepAt);
  if (/^\d{4}-\d{2}-\d{2}$/.test(ns) && !Number.isNaN(new Date(ns).getTime())) nextStepAt = ns;
  return {
    name: clean(body.name),
    company: clean(body.company),
    email: clean(body.email),
    phone: clean(body.phone),
    source: clean(body.source),
    status,
    value,
    notes: clean(body.notes),
    nextStep: clean(body.nextStep),
    nextStepAt,
  };
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
  const s = (v) => (typeof v === "string" ? v.trim() : "");
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

function startResearchJob(runner) {
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const job = { id, status: "running", steps: [], lead: null, error: null, finishedAt: 0, controller };
  researchJobs.set(id, job);

  const onProgress = (text) => {
    if (typeof text !== "string" || !text) return;
    job.steps.push({ t: Date.now(), text });
    if (job.steps.length > 60) job.steps.shift();
  };

  (async () => {
    try {
      job.lead = await runner(onProgress, controller.signal);
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

// Einbettung in Nextcloud (iframe) erlauben, wenn FRAME_ANCESTORS gesetzt ist.
if (FRAME_ANCESTORS) {
  const policy = `frame-ancestors 'self' ${FRAME_ANCESTORS}`;
  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", policy);
    next();
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
  });
});

// Einstellungen lesen
app.get("/api/settings", (req, res) => {
  res.json({ model: currentModel, models: AVAILABLE_MODELS, stageProbabilities });
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
  res.json({ model: currentModel, models: AVAILABLE_MODELS, stageProbabilities });
}));

// Liste aller Leads
app.get("/api/leads", wrap(async (req, res) => {
  res.json(await db.listLeads());
}));

// Statistiken für das Dashboard
app.get("/api/stats", wrap(async (req, res) => {
  res.json(await db.getStats(STATUSES, stageProbabilities));
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
app.post("/api/leads/research", wrap(async (req, res) => {
  if (!requireAi(res)) return;
  const input = typeof req.body.input === "string" ? req.body.input.trim() : "";
  if (!input) {
    return res.status(400).json({ error: "Firmenname oder Website-URL ist erforderlich." });
  }
  const job = startResearchJob(async (onProgress, signal) => {
    const research = await researchCompany(anthropic, input, currentModel, onProgress, signal);
    const data = { ...leadFromResearch(research, input), status: "neu", value: 0, notes: "" };
    const lead = await db.createLead(data, research);
    await logActivity(lead.id, { type: "system", title: "Per Recherche angelegt", body: `Input: ${input}` }, "KI-Recherche");
    return scoreAfterResearch(lead, onProgress);
  });
  res.status(202).json({ jobId: job.id });
}));

// Bestehenden Lead neu recherchieren (Daten aktualisieren) – ebenfalls als Job.
app.post("/api/leads/:id/research", wrap(async (req, res) => {
  if (!requireAi(res)) return;
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
    const research = await researchCompany(anthropic, input, currentModel, onProgress, signal);
    const data = leadFromResearch(research, input);
    const updated = await db.setLeadResearch(lead.id, research, data);
    await logActivity(lead.id, { type: "system", title: "Recherche aktualisiert", body: `Input: ${input}` }, "KI-Recherche");
    return scoreAfterResearch(updated, onProgress);
  });
  res.status(202).json({ jobId: job.id });
}));

// Status + Fortschritt eines Recherche-Jobs abfragen (Polling).
app.get("/api/research/:jobId", (req, res) => {
  const job = researchJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Recherche-Job nicht gefunden." });
  res.json({ status: job.status, steps: job.steps, lead: job.lead, error: job.error });
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

async function callClaude(system, userText, { json = false } = {}) {
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
            score: { type: "integer" },
            grade: { type: "string", enum: ["A", "B", "C", "D"] },
            reasoning: { type: "string" },
            nextStep: { type: "string" },
            value: {
              type: "integer",
              description:
                "Geschätzter Auftragswert in EUR (Einmalprojekt; bei laufenden/SaaS-Erlösen den 12-Monats-Wert). 0, wenn nicht seriös schätzbar.",
            },
            valueReasoning: {
              type: "string",
              description: "Kurze Begründung der Wertschätzung (Signale, angenommene Leistung).",
            },
          },
          required: ["score", "grade", "reasoning", "nextStep", "value", "valueReasoning"],
          additionalProperties: false,
        },
      },
    };
  }
  const msg = await anthropic.messages.create(params);
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
      "individueller KI-Systeme im Mittelstand/Handwerk). Bewerte Qualität und Abschlusspotenzial eines Leads " +
      "und schätze den realistischen Auftragswert in EUR. Leite den Wert aus belegten Signalen ab " +
      "(Unternehmensgröße/Standorte/Branche, passende Leistung: Potenzialanalyse, Workshop, KI-Integration oder " +
      "TelKI-SaaS). Sei eher konservativ; wenn keine seriöse Schätzung möglich ist, value=0. " +
      "Antworte ausschließlich im geforderten JSON-Format, kurz und auf Deutsch.",
    `Bewerte diesen Lead von 0 (kalt) bis 100 (sehr heiß), vergib eine Schulnote A–D und schätze den Auftragswert.\n\n${leadContext(lead)}`,
    { json: true }
  );
  const result = JSON.parse(raw);
  let value = Math.round(Number(result.value));
  if (!Number.isFinite(value) || value < 0) value = 0;
  return {
    score: Math.max(0, Math.min(100, Number(result.score) || 0)),
    grade: result.grade || "C",
    reasoning: result.reasoning || "",
    nextStep: result.nextStep || "",
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
    nextStep: r.nextStep, valueReasoning: r.valueReasoning, scoredAt: r.scoredAt,
  };
  let updated = await db.setLeadAi(lead.id, ai);
  if (r.value > 0 && (!lead.value || Number(lead.value) === 0)) {
    updated = await db.updateLead(lead.id, sanitizeLead({ ...(updated || lead), value: r.value }));
  }
  return { lead: updated || lead, ai: r };
}

// KI-Bewertung / Lead-Scoring
app.post("/api/leads/:id/score", wrap(async (req, res) => {
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
app.post("/api/leads/:id/email", wrap(async (req, res) => {
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
      `Ziel der E-Mail: ${goal}\n\nLead:\n${leadContext(lead)}`
    );
    await logActivity(lead.id, { type: "email", title: "KI-E-Mail-Entwurf erstellt", body: text }, actor(req));
    res.json({ email: text });
  } catch (err) {
    (req.log || logger).error("email_failed", { leadId: req.params.id, error: err.message });
    res.status(502).json({ error: "E-Mail-Entwurf fehlgeschlagen. Bitte erneut versuchen." });
  }
}));

// KI-Empfehlung / Next Best Action
app.post("/api/leads/:id/insights", wrap(async (req, res) => {
  if (!requireAi(res)) return;
  const lead = await db.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead nicht gefunden." });
  try {
    const text = await callClaude(
      "Du bist Vertriebs-Coach für FU/GE Solutions und bereitest Cold Calls vor. Gib eine kurze, konkrete " +
        "Handlungsempfehlung auf Deutsch: 2–4 priorisierte nächste Schritte als Aufzählung, abgeleitet aus den " +
        "belegten Ansatzpunkten und Potenzialen des Recherche-Dossiers. Pragmatisch und umsetzbar.",
      `Was sind die besten nächsten Schritte für diesen Lead?\n\n${leadContext(lead)}`
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
  const clean = (v) => (typeof v === "string" ? v.trim() : "");
  let type = clean(req.body.type).toLowerCase();
  if (!ACTIVITY_TYPES.includes(type)) type = "note";
  const title = clean(req.body.title);
  const body = clean(req.body.body);
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
    app.listen(PORT, () => {
      logger.info("server_started", {
        port: PORT,
        aiEnabled: aiEnabled(),
        model: aiEnabled() ? currentModel : null,
        frameAncestors: FRAME_ANCESTORS || null,
      });
    });
  })
  .catch((err) => {
    logger.error("startup_failed", { error: err.message });
    process.exit(1);
  });
