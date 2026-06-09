"use strict";

const { Pool } = require("pg");

// Verbindung über DATABASE_URL (z. B. in docker-compose gesetzt) oder über die
// Standard-PG*-Umgebungsvariablen (PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT).
const pool = new Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}
);

pool.on("error", (err) => {
  console.error("Unerwarteter Fehler im DB-Pool:", err.message);
});

// Wandelt eine DB-Zeile (snake_case) in die vom Frontend erwartete Form (camelCase) um.
function rowToLead(row) {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    email: row.email,
    phone: row.phone,
    source: row.source,
    status: row.status,
    value: Number(row.value),
    notes: row.notes,
    ai: row.ai, // JSONB → bereits als Objekt/null geparst
    research: row.research, // JSONB → strukturierte Lead-Recherche (oder null)
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Schema anlegen. Wartet mit Retry, bis die Datenbank erreichbar ist
// (der DB-Container braucht beim ersten Start einen Moment).
async function init({ retries = 15, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS leads (
          id          UUID PRIMARY KEY,
          name        TEXT        NOT NULL DEFAULT '',
          company     TEXT        NOT NULL DEFAULT '',
          email       TEXT        NOT NULL DEFAULT '',
          phone       TEXT        NOT NULL DEFAULT '',
          source      TEXT        NOT NULL DEFAULT '',
          status      TEXT        NOT NULL DEFAULT 'neu',
          value       NUMERIC     NOT NULL DEFAULT 0,
          notes       TEXT        NOT NULL DEFAULT '',
          ai          JSONB,
          research    JSONB,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      // Spalte für bestehende Datenbanken nachrüsten (idempotent).
      await pool.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS research JSONB;");
      await pool.query("CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);");
      // Schlüssel/Wert-Tabelle für App-Einstellungen (z. B. gewähltes KI-Modell).
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      // Aktivitäten-Timeline: jeder Touchpoint (Notiz, Anruf, Mail, Termin) und
      // automatische System-/KI-Ereignisse je Lead, chronologisch.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS activities (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          lead_id     UUID        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
          type        TEXT        NOT NULL DEFAULT 'note',
          title       TEXT        NOT NULL DEFAULT '',
          body        TEXT        NOT NULL DEFAULT '',
          outcome     TEXT        NOT NULL DEFAULT '',
          actor       TEXT        NOT NULL DEFAULT '',
          meta        JSONB,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query("CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id, created_at DESC);");
      // Aufgaben-Funktion wurde entfernt: Alttabelle und zugehörige
      // System-Verlaufseinträge idempotent bereinigen.
      await pool.query("DROP TABLE IF EXISTS tasks;");
      await pool.query("DELETE FROM activities WHERE type = 'system' AND title LIKE 'Aufgabe %';");
      console.log("Datenbank verbunden, Schema bereit.");
      return;
    } catch (err) {
      if (attempt === retries) {
        console.error("Datenbank nicht erreichbar nach mehreren Versuchen:", err.message);
        throw err;
      }
      console.log(`Warte auf Datenbank (Versuch ${attempt}/${retries})…`);
      await sleep(delayMs);
    }
  }
}

async function listLeads() {
  const { rows } = await pool.query("SELECT * FROM leads ORDER BY created_at DESC");
  return rows.map(rowToLead);
}

async function getLead(id) {
  const { rows } = await pool.query("SELECT * FROM leads WHERE id = $1", [id]);
  return rows[0] ? rowToLead(rows[0]) : null;
}

async function createLead(data, research = null) {
  const { rows } = await pool.query(
    `INSERT INTO leads (id, name, company, email, phone, source, status, value, notes, research)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [data.name, data.company, data.email, data.phone, data.source, data.status, data.value, data.notes, research]
  );
  return rowToLead(rows[0]);
}

async function updateLead(id, data) {
  const { rows } = await pool.query(
    `UPDATE leads
     SET name = $2, company = $3, email = $4, phone = $5, source = $6,
         status = $7, value = $8, notes = $9, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, data.name, data.company, data.email, data.phone, data.source, data.status, data.value, data.notes]
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

async function setLeadAi(id, ai) {
  const { rows } = await pool.query(
    "UPDATE leads SET ai = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [id, ai]
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

// Aktualisiert die Recherchedaten eines Leads und übernimmt die abgeleiteten
// Stammdaten (Firma, Ansprechpartner, Kontakt) gleich mit.
async function setLeadResearch(id, research, data) {
  const { rows } = await pool.query(
    `UPDATE leads
     SET research = $2, name = $3, company = $4, email = $5, phone = $6, source = $7,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, research, data.name, data.company, data.email, data.phone, data.source]
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

// Aktualisiert ausschließlich die Recherchedaten (JSONB) eines Leads – ohne
// die Stammdaten anzufassen. Wird für die manuelle Bearbeitung des Dossiers
// auf der Detailseite verwendet (kein erneuter KI-Lauf).
async function updateLeadResearch(id, research) {
  const { rows } = await pool.query(
    "UPDATE leads SET research = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [id, research]
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

async function deleteLead(id) {
  const { rowCount } = await pool.query("DELETE FROM leads WHERE id = $1", [id]);
  return rowCount > 0;
}

async function getSetting(key) {
  const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = $1", [key]);
  return rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

// probabilities: { status: Prozent } – gewichtet den offenen Pipeline-Wert nach
// Abschlusswahrscheinlichkeit (Erwartungswert). Offen = nicht gewonnen/verloren.
async function getStats(statuses, probabilities = {}) {
  const { rows } = await pool.query(
    "SELECT status, COUNT(*)::int AS count, COALESCE(SUM(value), 0)::float AS sum FROM leads GROUP BY status"
  );
  const byStatus = {};
  for (const s of statuses) byStatus[s] = 0;
  let total = 0;
  let pipelineValue = 0; // roh (ungewichtet)
  let weightedPipelineValue = 0; // Σ value × Wahrscheinlichkeit
  let wonValue = 0;
  for (const r of rows) {
    byStatus[r.status] = r.count;
    total += r.count;
    if (r.status === "gewonnen") {
      wonValue += r.sum;
    } else if (r.status !== "verloren") {
      pipelineValue += r.sum;
      const p = Number(probabilities[r.status]);
      weightedPipelineValue += r.sum * ((Number.isFinite(p) ? p : 0) / 100);
    }
  }
  const closed = (byStatus["gewonnen"] || 0) + (byStatus["verloren"] || 0);
  const conversion = closed > 0 ? Math.round(((byStatus["gewonnen"] || 0) / closed) * 100) : 0;
  return { total, byStatus, pipelineValue, weightedPipelineValue, wonValue, conversion };
}

// --- Aktivitäten-Timeline --------------------------------------------------
function rowToActivity(row) {
  return {
    id: row.id,
    leadId: row.lead_id,
    type: row.type,
    title: row.title,
    body: row.body,
    outcome: row.outcome,
    actor: row.actor,
    meta: row.meta || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

async function listActivities(leadId) {
  const { rows } = await pool.query(
    "SELECT * FROM activities WHERE lead_id = $1 ORDER BY created_at DESC",
    [leadId]
  );
  return rows.map(rowToActivity);
}

async function createActivity(a) {
  const { rows } = await pool.query(
    `INSERT INTO activities (lead_id, type, title, body, outcome, actor, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [a.leadId, a.type || "note", a.title || "", a.body || "", a.outcome || "", a.actor || "", a.meta || null]
  );
  return rowToActivity(rows[0]);
}

async function deleteActivity(id) {
  const { rowCount } = await pool.query("DELETE FROM activities WHERE id = $1", [id]);
  return rowCount > 0;
}

// --- Reporting -------------------------------------------------------------
// Liefert die Daten für die Berichte-Seite in einem Rutsch.
async function getReport(statuses, probabilities = {}) {
  const stats = await getStats(statuses, probabilities);

  // Wert je Status (für den Trichter).
  const funnelRes = await pool.query(
    "SELECT status, COUNT(*)::int AS count, COALESCE(SUM(value),0)::float AS value FROM leads GROUP BY status"
  );
  const funnelMap = {};
  for (const r of funnelRes.rows) funnelMap[r.status] = { count: r.count, value: r.value };
  const funnel = statuses.map((s) => ({
    status: s,
    count: (funnelMap[s] && funnelMap[s].count) || 0,
    value: (funnelMap[s] && funnelMap[s].value) || 0,
  }));

  // Gewonnener Umsatz je Monat (Status gewonnen; updated_at als Abschlussdatum).
  const wonRes = await pool.query(
    `SELECT to_char(date_trunc('month', updated_at), 'YYYY-MM') AS month, COALESCE(SUM(value),0)::float AS value
     FROM leads
     WHERE status = 'gewonnen' AND updated_at >= date_trunc('month', now()) - interval '11 months'
     GROUP BY 1 ORDER BY 1`
  );
  const wonByMonth = fillMonths(wonRes.rows, "value");

  // Vertriebsaktivität je Monat: Anzahl Touchpoints (letzte 12 Monate, inkl. Lücken).
  const activityRes = await pool.query(
    `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, COUNT(*)::int AS count
     FROM activities
     WHERE created_at >= date_trunc('month', now()) - interval '11 months'
     GROUP BY 1 ORDER BY 1`
  );
  const activityByMonth = fillMonths(activityRes.rows, "count");

  // Durchschnittlicher Vertriebszyklus in Tagen: Anlage → Abschluss (gewonnen).
  // Näherung über updated_at als Abschlussdatum.
  const cycleRes = await pool.query(
    `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400), 0)::float AS days
     FROM leads WHERE status = 'gewonnen'`
  );
  const avgCycleDays = Math.round(cycleRes.rows[0].days);

  // Durchschnittlicher gewonnener Auftragswert.
  const avgWon = stats.byStatus["gewonnen"]
    ? Math.round(stats.wonValue / stats.byStatus["gewonnen"])
    : 0;

  return { stats, funnel, wonByMonth, activityByMonth, avgWon, avgCycleDays };
}

// Füllt fehlende Monate der letzten 12 Monate mit 0 auf.
function fillMonths(rows, key) {
  const map = {};
  for (const r of rows) map[r.month] = Number(r[key]) || 0;
  const out = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    out.push({ month: m, value: map[m] || 0 });
  }
  return out;
}

module.exports = {
  init,
  listLeads,
  getLead,
  createLead,
  updateLead,
  setLeadAi,
  setLeadResearch,
  updateLeadResearch,
  deleteLead,
  getSetting,
  setSetting,
  getStats,
  listActivities,
  createActivity,
  deleteActivity,
  getReport,
};
