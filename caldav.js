"use strict";

// --- CalDAV-Sync: Wiedervorlagen → Kalender (z. B. Nextcloud) ---------------
// Schreibt die Wiedervorlage eines Leads (next_step / next_step_at) als Termin
// in einen CalDAV-Kalender. Einseitig (App → Kalender): die App ist die Quelle
// der Wahrheit, der Kalender spiegelt nur. Pro Lead existiert genau ein Termin
// (stabile UID/Resource aus der Lead-ID) – Anlegen, Aktualisieren und Löschen
// laufen damit idempotent über denselben .ics-Pfad.
//
// Bewusst abhängigkeitsfrei: globales `fetch` (CalDAV ist simples HTTP – PUT
// einer .ics-Datei bzw. DELETE) und `Buffer` für Basic-Auth/Base64. Aktiv nur,
// wenn CALDAV_URL, CALDAV_USERNAME und CALDAV_PASSWORD gesetzt sind – sonst
// vollständiger No-Op (die App läuft unverändert weiter).
//
// Robustheit: Keine der exportierten Funktionen wirft. Ein nicht erreichbarer
// oder fehlkonfigurierter Kalender darf den Lead-Speichervorgang nie scheitern
// lassen – Fehler werden nur geloggt (vgl. logActivity/scoreAfterResearch).

const fs = require("fs");
const { logger } = require("./logger");

// Liest ein Secret bevorzugt aus <NAME>_FILE (Docker-Secret-Konvention), sonst
// aus der Umgebungsvariable – analog zu server.js, hier modul-lokal gehalten.
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

// Kollektions-URL des Kalenders, z. B.
//   https://cloud.example.de/remote.php/dav/calendars/<user>/<kalender>/
const CALDAV_URL = String(process.env.CALDAV_URL || "").trim();
const CALDAV_USERNAME = String(process.env.CALDAV_USERNAME || "").trim();
const CALDAV_PASSWORD = readSecret("CALDAV_PASSWORD");

// Optionale Uhrzeit "HH:MM" für den Termin. Leer = Ganztags-Termin (Standard,
// zeitzonensicher und ehrlich, da die Wiedervorlage nur ein Datum kennt). Mit
// gesetzter Uhrzeit wird ein Termin mit Dauer angelegt (lokale „floating" Zeit
// ohne VTIMEZONE – für einen Nutzer in einer Zeitzone korrekt).
const EVENT_TIME_MIN = parseHhmm(process.env.CALDAV_EVENT_TIME);
const EVENT_DURATION_MIN = clampInt(process.env.CALDAV_EVENT_DURATION_MIN, 30, 1, 1440);
// Optionale Erinnerung (VALARM): Minuten vor Beginn. 0/leer = keine Erinnerung.
const REMINDER_MIN = clampInt(process.env.CALDAV_REMINDER_MIN, 0, 0, 40320);
// Öffentliche Basis-URL der App für den Rücklink zum Lead (z. B.
// https://leads.example.de). Bevorzugt vor einer aus dem Request abgeleiteten.
const APP_BASE_URL = String(process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");

const TIMEOUT_MS = 10000; // CalDAV-Aufrufe knapp deckeln – nie den Save blockieren

function parseHhmm(v) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(v || ""));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function clampInt(v, dflt, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function isEnabled() {
  return Boolean(CALDAV_URL && CALDAV_USERNAME && CALDAV_PASSWORD);
}

// Soll dieser Lead einen Kalender-Termin haben? Genau dann, wenn eine gültige
// Wiedervorlage vorliegt und der Lead noch „offen" ist – gewonnene/verlorene
// Leads brauchen keine Wiedervorlage mehr (deckt sich mit der „Heute"-Agenda).
function shouldHaveEvent(lead) {
  return Boolean(
    lead &&
      typeof lead.nextStepAt === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(lead.nextStepAt) &&
      lead.status !== "gewonnen" &&
      lead.status !== "verloren"
  );
}

// Fingerabdruck der termin-relevanten Felder – damit ein unbeteiligtes Update
// (z. B. nur eine Notiz geändert) nicht unnötig erneut in den Kalender schreibt.
function fingerprint(lead) {
  if (!lead) return "";
  return JSON.stringify([
    lead.nextStepAt || "",
    lead.nextStep || "",
    lead.company || "",
    lead.name || "",
    lead.phone || "",
    lead.email || "",
    lead.status || "",
    Number(lead.value) || 0,
  ]);
}

// --- iCalendar-Erzeugung ---------------------------------------------------
const pad = (n) => String(n).padStart(2, "0");

function uidFor(leadId) {
  return `leadpilot-${leadId}`;
}

function eventUrl(leadId) {
  const base = CALDAV_URL.endsWith("/") ? CALDAV_URL : `${CALDAV_URL}/`;
  return `${base}leadpilot-${encodeURIComponent(leadId)}.ics`;
}

// "YYYY-MM-DD" → "YYYYMMDD".
function ymdCompact(ymd) {
  return String(ymd).slice(0, 10).replace(/-/g, "");
}

// Tag nach dem Datum als "YYYYMMDD" (DTEND ist bei Ganztags-Terminen exklusiv).
function nextDayCompact(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
}

// UTC-Zeitstempel "YYYYMMDDTHHMMSSZ" (für DTSTAMP).
function utcStamp(date = new Date()) {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

// „Floating" Wandzeit "YYYYMMDDTHHMMSS" (ohne Z/TZID) = lokale Zeit des Kalenders.
// Arithmetik bewusst in UTC, damit die Server-Zeitzone die Ausgabe nicht verschiebt.
function floating(ymd, minutesFromMidnight) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  dt.setUTCMinutes(dt.getUTCMinutes() + minutesFromMidnight);
  return (
    `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}` +
    `T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}${pad(dt.getUTCSeconds())}`
  );
}

// SEQUENCE muss bei Änderungen monoton steigen (sonst ignorieren manche Clients
// das Update). Aus updatedAt abgeleitet (Sekunden seit 2024) – steigt pro Lead
// und bleibt über Jahrzehnte im Integer-Bereich.
function sequence(lead) {
  const t = Date.parse(lead && lead.updatedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((t - Date.UTC(2024, 0, 1)) / 1000));
}

// iCalendar-Text-Escaping (RFC 5545 §3.3.11): Reihenfolge wichtig (Backslash zuerst).
function esc(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Zeilen auf ≤75 Oktette falten (RFC 5545 §3.1); Folgezeilen mit führendem
// Leerzeichen. Byte-genau und ohne Multibyte-Zeichen (Umlaute) zu zerschneiden.
function foldLine(line) {
  let out = "";
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (curBytes + chBytes > limit) {
      out += (out ? "\r\n " : "") + cur;
      cur = ch;
      curBytes = chBytes;
      limit = 74; // Folgezeilen tragen ein führendes Leerzeichen (+1 Oktett)
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  out += (out ? "\r\n " : "") + cur;
  return out;
}

function leadUrl(leadId, baseUrl) {
  const base = (APP_BASE_URL || String(baseUrl || "")).replace(/\/+$/, "");
  if (!base) return "";
  return `${base}/#/lead/${encodeURIComponent(leadId)}`;
}

function summaryFor(lead) {
  const base = (lead.company || lead.name || "Lead").trim();
  const step = (lead.nextStep || "").trim();
  const s = step ? `Wiedervorlage: ${base} – ${step}` : `Wiedervorlage: ${base}`;
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}

function descriptionFor(lead, baseUrl) {
  const parts = [];
  if (lead.nextStep) parts.push(`Nächster Schritt: ${lead.nextStep}`);
  if (lead.company) parts.push(`Firma: ${lead.company}`);
  if (lead.name) parts.push(`Ansprechpartner: ${lead.name}`);
  if (lead.phone) parts.push(`Telefon: ${lead.phone}`);
  if (lead.email) parts.push(`E-Mail: ${lead.email}`);
  if (lead.status) parts.push(`Status: ${lead.status}`);
  if (Number(lead.value) > 0) parts.push(`Wert: ${Number(lead.value).toLocaleString("de-DE")} €`);
  const url = leadUrl(lead.id, baseUrl);
  if (url) {
    parts.push("");
    parts.push(`Lead öffnen: ${url}`);
  }
  return parts.join("\n");
}

// Baut die vollständige .ics (VCALENDAR mit einem VEVENT) für einen Lead.
function buildICS(lead, { baseUrl } = {}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//LeadPilot//Wiedervorlage//DE",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uidFor(lead.id)}`,
    `DTSTAMP:${utcStamp()}`,
    `SEQUENCE:${sequence(lead)}`,
  ];
  if (EVENT_TIME_MIN === null) {
    // Ganztags-Termin
    lines.push(`DTSTART;VALUE=DATE:${ymdCompact(lead.nextStepAt)}`);
    lines.push(`DTEND;VALUE=DATE:${nextDayCompact(lead.nextStepAt)}`);
  } else {
    // Termin mit Uhrzeit und Dauer
    lines.push(`DTSTART:${floating(lead.nextStepAt, EVENT_TIME_MIN)}`);
    lines.push(`DTEND:${floating(lead.nextStepAt, EVENT_TIME_MIN + EVENT_DURATION_MIN)}`);
  }
  lines.push(`SUMMARY:${esc(summaryFor(lead))}`);
  const desc = descriptionFor(lead, baseUrl);
  if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
  const url = leadUrl(lead.id, baseUrl);
  if (url) lines.push(`URL:${esc(url)}`);
  lines.push("CATEGORIES:LeadPilot,Wiedervorlage");
  lines.push("STATUS:CONFIRMED");
  lines.push("TRANSP:TRANSPARENT"); // blockt keine Verfügbarkeit (es ist eine Erinnerung)
  if (REMINDER_MIN > 0) {
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push(`DESCRIPTION:${esc(summaryFor(lead))}`);
    lines.push(`TRIGGER:-PT${REMINDER_MIN}M`);
    lines.push("END:VALARM");
  }
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// --- CalDAV-HTTP -----------------------------------------------------------
function authHeader() {
  return "Basic " + Buffer.from(`${CALDAV_USERNAME}:${CALDAV_PASSWORD}`).toString("base64");
}

async function putEvent(lead, baseUrl) {
  const res = await fetch(eventUrl(lead.id), {
    method: "PUT",
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      Authorization: authHeader(),
    },
    body: buildICS(lead, { baseUrl }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`PUT HTTP ${res.status}`);
}

async function deleteEvent(leadId) {
  const res = await fetch(eventUrl(leadId), {
    method: "DELETE",
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 404 = schon weg (oder nie angelegt) → als Erfolg behandeln.
  if (!res.ok && res.status !== 404) throw new Error(`DELETE HTTP ${res.status}`);
  return res.status;
}

// --- Öffentliche, fehlertolerante API --------------------------------------
// Synchronisiert den Kalender-Termin eines Leads nach einem Anlegen/Update.
// `prev` = Zustand vor dem Update (oder null beim Anlegen). Wirft nie.
async function syncLead(lead, prev = null, baseUrl = "") {
  if (!isEnabled() || !lead) return;
  try {
    const want = shouldHaveEvent(lead);
    const had = shouldHaveEvent(prev);
    if (want) {
      // Nur schreiben, wenn neu oder ein relevantes Feld sich geändert hat.
      if (!had || fingerprint(lead) !== fingerprint(prev)) {
        await putEvent(lead, baseUrl);
        logger.info("caldav_event_synced", { leadId: lead.id, op: had ? "update" : "create" });
      }
    } else if (had) {
      await deleteEvent(lead.id);
      logger.info("caldav_event_removed", { leadId: lead.id, reason: "no_followup" });
    }
  } catch (err) {
    logger.warn("caldav_sync_failed", { leadId: lead && lead.id, error: err.message });
  }
}

// Entfernt den Termin eines Leads (z. B. beim Löschen des Leads). Wirft nie.
async function removeLead(leadId) {
  if (!isEnabled() || !leadId) return;
  try {
    const status = await deleteEvent(leadId);
    if (status !== 404) logger.info("caldav_event_removed", { leadId, reason: "lead_deleted" });
  } catch (err) {
    logger.warn("caldav_delete_failed", { leadId, error: err.message });
  }
}

// Redigierte Zusammenfassung für Start-Log / Diagnose (keine Geheimnisse).
function describe() {
  let host = "";
  try {
    host = new URL(CALDAV_URL).host;
  } catch {
    host = "";
  }
  return {
    enabled: isEnabled(),
    host,
    user: CALDAV_USERNAME ? "set" : "",
    mode: EVENT_TIME_MIN === null ? "all-day" : "timed",
    reminderMin: REMINDER_MIN || 0,
  };
}

module.exports = {
  isEnabled,
  syncLead,
  removeLead,
  describe,
  // Für Tests/Diagnose exportiert:
  buildICS,
  shouldHaveEvent,
  uidFor,
  eventUrl,
};
