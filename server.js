"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "leads.json");

// --- Anthropic / KI-Setup --------------------------------------------------
// Das SDK wird nur geladen, wenn ein API-Key vorhanden ist. So läuft die App
// auch ohne KI-Konfiguration vollständig (nur die KI-Buttons sind dann inaktiv).
const MODEL = "claude-opus-4-8";
let anthropic = null;
try {
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require("@anthropic-ai/sdk");
    anthropic = new Anthropic();
  }
} catch (err) {
  console.warn("Anthropic SDK konnte nicht geladen werden:", err.message);
}

const aiEnabled = () => Boolean(anthropic);

// --- Datenspeicher (einfache JSON-Datei) -----------------------------------
const STATUSES = ["neu", "kontaktiert", "qualifiziert", "angebot", "gewonnen", "verloren"];

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ leads: [] }, null, 2));
}

function readLeads() {
  ensureStore();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.leads) ? parsed.leads : [];
  } catch (err) {
    console.error("Konnte Leads nicht lesen:", err.message);
    return [];
  }
}

function writeLeads(leads) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify({ leads }, null, 2));
}

function sanitizeLead(body = {}) {
  const clean = (v) => (typeof v === "string" ? v.trim() : "");
  let status = clean(body.status).toLowerCase();
  if (!STATUSES.includes(status)) status = "neu";
  let value = Number(body.value);
  if (!Number.isFinite(value) || value < 0) value = 0;
  return {
    name: clean(body.name),
    company: clean(body.company),
    email: clean(body.email),
    phone: clean(body.phone),
    source: clean(body.source),
    status,
    value,
    notes: clean(body.notes),
  };
}

// --- App -------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Health / Konfiguration
app.get("/api/config", (req, res) => {
  res.json({ aiEnabled: aiEnabled(), model: MODEL, statuses: STATUSES });
});

// Liste aller Leads
app.get("/api/leads", (req, res) => {
  res.json(readLeads());
});

// Statistiken für das Dashboard
app.get("/api/stats", (req, res) => {
  const leads = readLeads();
  const byStatus = {};
  for (const s of STATUSES) byStatus[s] = 0;
  let pipelineValue = 0;
  let wonValue = 0;
  for (const l of leads) {
    byStatus[l.status] = (byStatus[l.status] || 0) + 1;
    if (l.status === "gewonnen") wonValue += Number(l.value) || 0;
    else if (l.status !== "verloren") pipelineValue += Number(l.value) || 0;
  }
  const closed = byStatus["gewonnen"] + byStatus["verloren"];
  const conversion = closed > 0 ? Math.round((byStatus["gewonnen"] / closed) * 100) : 0;
  res.json({ total: leads.length, byStatus, pipelineValue, wonValue, conversion });
});

// Lead anlegen
app.post("/api/leads", (req, res) => {
  const data = sanitizeLead(req.body);
  if (!data.name && !data.company) {
    return res.status(400).json({ error: "Name oder Firma ist erforderlich." });
  }
  const leads = readLeads();
  const now = new Date().toISOString();
  const lead = { id: crypto.randomUUID(), ...data, ai: null, createdAt: now, updatedAt: now };
  leads.unshift(lead);
  writeLeads(leads);
  res.status(201).json(lead);
});

// Lead aktualisieren
app.put("/api/leads/:id", (req, res) => {
  const leads = readLeads();
  const idx = leads.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Lead nicht gefunden." });
  const data = sanitizeLead({ ...leads[idx], ...req.body });
  leads[idx] = { ...leads[idx], ...data, updatedAt: new Date().toISOString() };
  writeLeads(leads);
  res.json(leads[idx]);
});

// Lead löschen
app.delete("/api/leads/:id", (req, res) => {
  const leads = readLeads();
  const next = leads.filter((l) => l.id !== req.params.id);
  if (next.length === leads.length) return res.status(404).json({ error: "Lead nicht gefunden." });
  writeLeads(next);
  res.status(204).end();
});

// --- KI-Endpunkte ----------------------------------------------------------
function getLeadOr404(req, res) {
  const leads = readLeads();
  const lead = leads.find((l) => l.id === req.params.id);
  if (!lead) {
    res.status(404).json({ error: "Lead nicht gefunden." });
    return null;
  }
  return { leads, lead };
}

function leadContext(lead) {
  return [
    `Name: ${lead.name || "—"}`,
    `Firma: ${lead.company || "—"}`,
    `E-Mail: ${lead.email || "—"}`,
    `Telefon: ${lead.phone || "—"}`,
    `Quelle: ${lead.source || "—"}`,
    `Status: ${lead.status}`,
    `Geschätzter Wert: ${lead.value} €`,
    `Notizen: ${lead.notes || "—"}`,
  ].join("\n");
}

async function callClaude(system, userText, { json = false } = {}) {
  const params = {
    model: MODEL,
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
          },
          required: ["score", "grade", "reasoning", "nextStep"],
          additionalProperties: false,
        },
      },
    };
  }
  const msg = await anthropic.messages.create(params);
  const text = msg.content.find((b) => b.type === "text");
  return text ? text.text : "";
}

// KI-Bewertung / Lead-Scoring
app.post("/api/leads/:id/score", async (req, res) => {
  if (!aiEnabled()) return res.status(503).json({ error: "KI ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt)." });
  const ctx = getLeadOr404(req, res);
  if (!ctx) return;
  try {
    const raw = await callClaude(
      "Du bist ein erfahrener B2B-Vertriebsanalyst. Bewerte die Qualität und das Abschlusspotenzial eines Leads. " +
        "Antworte ausschließlich im geforderten JSON-Format. Halte 'reasoning' und 'nextStep' kurz und auf Deutsch.",
      `Bewerte diesen Lead von 0 (kalt) bis 100 (sehr heiß) und vergib eine Schulnote A–D.\n\n${leadContext(ctx.lead)}`,
      { json: true }
    );
    const result = JSON.parse(raw);
    const score = Math.max(0, Math.min(100, Number(result.score) || 0));
    const ai = {
      score,
      grade: result.grade || "C",
      reasoning: result.reasoning || "",
      nextStep: result.nextStep || "",
      scoredAt: new Date().toISOString(),
    };
    const idx = ctx.leads.findIndex((l) => l.id === ctx.lead.id);
    ctx.leads[idx] = { ...ctx.leads[idx], ai, updatedAt: new Date().toISOString() };
    writeLeads(ctx.leads);
    res.json(ctx.leads[idx]);
  } catch (err) {
    console.error("Scoring-Fehler:", err.message);
    res.status(502).json({ error: "KI-Bewertung fehlgeschlagen. Bitte erneut versuchen." });
  }
});

// KI-E-Mail-Entwurf
app.post("/api/leads/:id/email", async (req, res) => {
  if (!aiEnabled()) return res.status(503).json({ error: "KI ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt)." });
  const ctx = getLeadOr404(req, res);
  if (!ctx) return;
  const goal = typeof req.body.goal === "string" && req.body.goal.trim()
    ? req.body.goal.trim()
    : "Erstkontakt herstellen und ein kurzes Kennenlerngespräch vorschlagen";
  try {
    const text = await callClaude(
      "Du bist ein professioneller Vertriebstexter. Schreibe eine personalisierte, freundliche und prägnante " +
        "Akquise-E-Mail auf Deutsch. Verwende eine klare Betreffzeile (Format: 'Betreff: ...'), eine persönliche Ansprache " +
        "und einen klaren Call-to-Action. Keine Floskeln, kein Spam-Ton, maximal 150 Wörter.",
      `Ziel der E-Mail: ${goal}\n\nKontaktdaten des Leads:\n${leadContext(ctx.lead)}`
    );
    res.json({ email: text });
  } catch (err) {
    console.error("E-Mail-Fehler:", err.message);
    res.status(502).json({ error: "E-Mail-Entwurf fehlgeschlagen. Bitte erneut versuchen." });
  }
});

// KI-Empfehlung / Next Best Action
app.post("/api/leads/:id/insights", async (req, res) => {
  if (!aiEnabled()) return res.status(503).json({ error: "KI ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt)." });
  const ctx = getLeadOr404(req, res);
  if (!ctx) return;
  try {
    const text = await callClaude(
      "Du bist ein Vertriebs-Coach. Gib eine kurze, konkrete Handlungsempfehlung auf Deutsch: " +
        "2–4 priorisierte nächste Schritte als Aufzählung. Pragmatisch und umsetzbar.",
      `Was sind die besten nächsten Schritte für diesen Lead?\n\n${leadContext(ctx.lead)}`
    );
    res.json({ insights: text });
  } catch (err) {
    console.error("Insights-Fehler:", err.message);
    res.status(502).json({ error: "Empfehlung fehlgeschlagen. Bitte erneut versuchen." });
  }
});

app.listen(PORT, () => {
  console.log(`Lead-Management läuft auf http://localhost:${PORT}`);
  console.log(`KI-Funktionen: ${aiEnabled() ? "aktiv (" + MODEL + ")" : "inaktiv (ANTHROPIC_API_KEY setzen)"}`);
});
