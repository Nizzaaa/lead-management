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

async function getStats(statuses) {
  const { rows } = await pool.query(
    "SELECT status, COUNT(*)::int AS count, COALESCE(SUM(value), 0)::float AS sum FROM leads GROUP BY status"
  );
  const byStatus = {};
  for (const s of statuses) byStatus[s] = 0;
  let total = 0;
  let pipelineValue = 0;
  let wonValue = 0;
  for (const r of rows) {
    byStatus[r.status] = r.count;
    total += r.count;
    if (r.status === "gewonnen") wonValue += r.sum;
    else if (r.status !== "verloren") pipelineValue += r.sum;
  }
  const closed = (byStatus["gewonnen"] || 0) + (byStatus["verloren"] || 0);
  const conversion = closed > 0 ? Math.round(((byStatus["gewonnen"] || 0) / closed) * 100) : 0;
  return { total, byStatus, pipelineValue, wonValue, conversion };
}

module.exports = {
  init,
  listLeads,
  getLead,
  createLead,
  updateLead,
  setLeadAi,
  setLeadResearch,
  deleteLead,
  getSetting,
  setSetting,
  getStats,
};
