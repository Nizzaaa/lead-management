"use strict";

const express = require("express");
const path = require("path");
const db = require("./db");
const { researchCompany } = require("./research");

const PORT = process.env.PORT || 3000;

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

const STATUSES = ["neu", "kontaktiert", "qualifiziert", "angebot", "gewonnen", "verloren"];

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

// Kleiner Wrapper, damit Fehler in async-Handlern sauber als 500 landen.
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error("Serverfehler:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "Interner Serverfehler." });
  });

// --- App -------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Health / Konfiguration
app.get("/api/config", (req, res) => {
  res.json({ aiEnabled: aiEnabled(), model: MODEL, statuses: STATUSES });
});

// Liste aller Leads
app.get("/api/leads", wrap(async (req, res) => {
  res.json(await db.listLeads());
}));

// Statistiken für das Dashboard
app.get("/api/stats", wrap(async (req, res) => {
  res.json(await db.getStats(STATUSES));
}));

// Lead anlegen
app.post("/api/leads", wrap(async (req, res) => {
  const data = sanitizeLead(req.body);
  if (!data.name && !data.company) {
    return res.status(400).json({ error: "Name oder Firma ist erforderlich." });
  }
  const lead = await db.createLead(data);
  res.status(201).json(lead);
}));

// Lead per Recherche anlegen: Eingabe = Firmenname ODER Website-URL.
// Recherchiert automatisch alle Skill-Felder und speichert sie.
app.post("/api/leads/research", wrap(async (req, res) => {
  if (!requireAi(res)) return;
  const input = typeof req.body.input === "string" ? req.body.input.trim() : "";
  if (!input) {
    return res.status(400).json({ error: "Firmenname oder Website-URL ist erforderlich." });
  }
  try {
    const research = await researchCompany(anthropic, input);
    const data = {
      ...leadFromResearch(research, input),
      status: "neu",
      value: 0,
      notes: "",
    };
    const lead = await db.createLead(data, research);
    res.status(201).json(lead);
  } catch (err) {
    console.error("Recherche-Fehler:", err.message);
    res.status(502).json({ error: "Recherche fehlgeschlagen. Bitte erneut versuchen." });
  }
}));

// Bestehenden Lead neu recherchieren (Daten aktualisieren).
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
  try {
    const research = await researchCompany(anthropic, input);
    const data = leadFromResearch(research, input);
    const updated = await db.setLeadResearch(lead.id, research, data);
    res.json(updated);
  } catch (err) {
    console.error("Recherche-Fehler:", err.message);
    res.status(502).json({ error: "Recherche fehlgeschlagen. Bitte erneut versuchen." });
  }
}));

// Lead aktualisieren
app.put("/api/leads/:id", wrap(async (req, res) => {
  const existing = await db.getLead(req.params.id);
  if (!existing) return res.status(404).json({ error: "Lead nicht gefunden." });
  const data = sanitizeLead({ ...existing, ...req.body });
  const lead = await db.updateLead(req.params.id, data);
  res.json(lead);
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

function requireAi(res) {
  if (!aiEnabled()) {
    res.status(503).json({ error: "KI ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt)." });
    return false;
  }
  return true;
}

// KI-Bewertung / Lead-Scoring
app.post("/api/leads/:id/score", wrap(async (req, res) => {
  if (!requireAi(res)) return;
  const lead = await db.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead nicht gefunden." });
  try {
    const raw = await callClaude(
      "Du bist ein erfahrener B2B-Vertriebsanalyst. Bewerte die Qualität und das Abschlusspotenzial eines Leads. " +
        "Antworte ausschließlich im geforderten JSON-Format. Halte 'reasoning' und 'nextStep' kurz und auf Deutsch.",
      `Bewerte diesen Lead von 0 (kalt) bis 100 (sehr heiß) und vergib eine Schulnote A–D.\n\n${leadContext(lead)}`,
      { json: true }
    );
    const result = JSON.parse(raw);
    const ai = {
      score: Math.max(0, Math.min(100, Number(result.score) || 0)),
      grade: result.grade || "C",
      reasoning: result.reasoning || "",
      nextStep: result.nextStep || "",
      scoredAt: new Date().toISOString(),
    };
    const updated = await db.setLeadAi(lead.id, ai);
    res.json(updated);
  } catch (err) {
    console.error("Scoring-Fehler:", err.message);
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
    res.json({ email: text });
  } catch (err) {
    console.error("E-Mail-Fehler:", err.message);
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
    res.json({ insights: text });
  } catch (err) {
    console.error("Insights-Fehler:", err.message);
    res.status(502).json({ error: "Empfehlung fehlgeschlagen. Bitte erneut versuchen." });
  }
}));

// --- Start -----------------------------------------------------------------
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Lead-Management läuft auf http://localhost:${PORT}`);
      console.log(`KI-Funktionen: ${aiEnabled() ? "aktiv (" + MODEL + ")" : "inaktiv (ANTHROPIC_API_KEY setzen)"}`);
    });
  })
  .catch((err) => {
    console.error("Start abgebrochen – Datenbank nicht verfügbar:", err.message);
    process.exit(1);
  });
