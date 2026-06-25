"use strict";

// --- CalDAV-Sync: Wiedervorlagen → Kalender (z. B. Nextcloud) ---------------
// Schreibt jede Wiedervorlage (follow_ups) eines Leads als eigenen Termin in
// einen CalDAV-Kalender. Einseitig (App → Kalender): die App ist die Quelle der
// Wahrheit, der Kalender spiegelt nur. Pro Wiedervorlage genau ein Termin
// (stabile UID/Resource aus der Follow-up-ID) – Anlegen, Aktualisieren und
// Löschen laufen idempotent über denselben .ics-Pfad. Bewusst entkoppelt vom
// Lead-Status: auch Wiedervorlagen auf gewonnenen Leads (Referenz/Jubiläum)
// erscheinen im Kalender.
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
// Automatische Wiedervorlagen (Referenz/Jubiläum) im Kalender anzeigen? Standard
// an; mit "0"/"false"/"off" abschaltbar – manuelle Wiedervorlagen bleiben unberührt.
const AUTO_FOLLOWUPS_ENABLED = !/^(0|false|off)$/i.test(String(process.env.CALDAV_AUTO_FOLLOWUPS || "").trim());

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

// Soll diese Wiedervorlage einen Kalender-Termin haben? Genau dann, wenn sie
// OFFEN ist und ein gültiges Datum trägt – unabhängig vom Lead-Status (auch
// gewonnene Leads behalten ihre Referenz-/Jubiläums-Termine). Automatische
// Wiedervorlagen können per Env-Schalter global ausgeblendet werden.
function shouldHaveEvent(followUp) {
  if (!followUp) return false;
  if (followUp.source === "auto" && !AUTO_FOLLOWUPS_ENABLED) return false;
  return Boolean(
    followUp.status === "open" &&
      typeof followUp.dueDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(followUp.dueDate)
  );
}

// Fingerabdruck der termin-relevanten Felder (Wiedervorlage + Lead-Anzeigedaten)
// – damit ein unbeteiligtes Update (z. B. nur eine Notiz) nicht erneut schreibt.
function fingerprint(lead, followUp) {
  if (!lead || !followUp) return "";
  return JSON.stringify([
    followUp.dueDate || "",
    followUp.title || "",
    followUp.kind || "",
    followUp.status || "",
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

function uidFor(followUpId) {
  return `leadpilot-${followUpId}`;
}

function eventUrl(followUpId) {
  const base = CALDAV_URL.endsWith("/") ? CALDAV_URL : `${CALDAV_URL}/`;
  return `${base}leadpilot-${encodeURIComponent(followUpId)}.ics`;
}

// Legacy-Pfad: vor der Umstellung gab es genau einen Termin je Lead
// (leadpilot-<leadId>.ics). Wird nur noch zum Aufräumen benutzt.
function legacyEventUrl(leadId) {
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
// das Update). Aus der Follow-up-updatedAt abgeleitet (Sekunden seit 2024) –
// steigt bei jeder Bearbeitung und bleibt über Jahrzehnte im Integer-Bereich.
function sequence(followUp) {
  const t = Date.parse(followUp && (followUp.updatedAt || followUp.createdAt));
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

// Titel des Termins: Sorte als Präfix (Referenz/Jubiläum) + Firma + Schritt.
function summaryFor(lead, followUp) {
  const base = (lead.company || lead.name || "").trim();
  const step = (followUp.title || "").trim();
  const prefix =
    followUp.kind === "reference" ? "Referenz"
    : followUp.kind === "anniversary" ? "Jubiläum"
    : "Lead";
  let s;
  if (base && step) s = `${prefix}: ${base} – ${step}`;
  else if (base) s = `${prefix}: ${base}`;
  else s = step || prefix;
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}

function descriptionFor(lead, followUp, baseUrl) {
  const parts = [];
  if (followUp.title) parts.push(`Wiedervorlage: ${followUp.title}`);
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

// Baut die vollständige .ics (VCALENDAR mit einem VEVENT) für eine Wiedervorlage.
function buildICS(lead, followUp, { baseUrl } = {}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//LeadPilot//Wiedervorlage//DE",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uidFor(followUp.id)}`,
    `DTSTAMP:${utcStamp()}`,
    `SEQUENCE:${sequence(followUp)}`,
  ];
  if (EVENT_TIME_MIN === null) {
    // Ganztags-Termin
    lines.push(`DTSTART;VALUE=DATE:${ymdCompact(followUp.dueDate)}`);
    lines.push(`DTEND;VALUE=DATE:${nextDayCompact(followUp.dueDate)}`);
  } else {
    // Termin mit Uhrzeit und Dauer
    lines.push(`DTSTART:${floating(followUp.dueDate, EVENT_TIME_MIN)}`);
    lines.push(`DTEND:${floating(followUp.dueDate, EVENT_TIME_MIN + EVENT_DURATION_MIN)}`);
  }
  lines.push(`SUMMARY:${esc(summaryFor(lead, followUp))}`);
  const desc = descriptionFor(lead, followUp, baseUrl);
  if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
  const url = leadUrl(lead.id, baseUrl);
  if (url) lines.push(`URL:${esc(url)}`);
  const kindCat = followUp.kind && followUp.kind !== "manual" ? `,${followUp.kind}` : "";
  lines.push(`CATEGORIES:LeadPilot,Wiedervorlage${kindCat}`);
  lines.push("STATUS:CONFIRMED");
  lines.push("TRANSP:TRANSPARENT"); // blockt keine Verfügbarkeit (es ist eine Erinnerung)
  if (REMINDER_MIN > 0) {
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push(`DESCRIPTION:${esc(summaryFor(lead, followUp))}`);
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

// Einheitlicher CalDAV-Aufruf. Übersetzt Netzwerk-/Timeout-Fehler in lesbare
// Meldungen (fetch wirft sonst nur ein generisches „fetch failed“) – wichtig,
// damit die manuelle Resync den Grund klar anzeigen kann.
async function caldavFetch(method, url, { body, contentType } = {}) {
  const headers = { Authorization: authHeader() };
  if (contentType) headers["Content-Type"] = contentType;
  try {
    return await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`Zeitüberschreitung nach ${TIMEOUT_MS / 1000}s (Kalender nicht erreichbar)`);
    }
    const cause = err && err.cause;
    const detail = (cause && (cause.code || cause.message)) || (err && err.message) || "";
    throw new Error(`Netzwerkfehler: Kalender nicht erreichbar${detail ? ` (${detail})` : ""}`);
  }
}

async function putEvent(lead, followUp, baseUrl) {
  const res = await caldavFetch("PUT", eventUrl(followUp.id), {
    body: buildICS(lead, followUp, { baseUrl }),
    contentType: "text/calendar; charset=utf-8",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
}

async function deleteEvent(followUpId) {
  const res = await caldavFetch("DELETE", eventUrl(followUpId));
  // 404 = schon weg (oder nie angelegt) → als Erfolg behandeln.
  if (!res.ok && res.status !== 404) {
    throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  }
  return res.status;
}

// --- Öffentliche, fehlertolerante API --------------------------------------
// Synchronisiert den Kalender-Termin einer Wiedervorlage nach Anlegen/Update.
// `prev` = { lead, followUp } vor dem Update (oder null beim Anlegen). Wirft nie.
async function syncFollowUp(lead, followUp, prev = null, baseUrl = "") {
  if (!isEnabled() || !lead || !followUp) return;
  try {
    const want = shouldHaveEvent(followUp);
    const prevFu = prev && prev.followUp;
    const prevLead = (prev && prev.lead) || lead;
    const had = shouldHaveEvent(prevFu);
    if (want) {
      // Nur schreiben, wenn neu oder ein relevantes Feld sich geändert hat.
      if (!had || fingerprint(lead, followUp) !== fingerprint(prevLead, prevFu)) {
        await putEvent(lead, followUp, baseUrl);
        logger.info("caldav_event_synced", { followUpId: followUp.id, leadId: lead.id, op: had ? "update" : "create" });
      }
    } else if (had) {
      await deleteEvent(followUp.id);
      logger.info("caldav_event_removed", { followUpId: followUp.id, leadId: lead.id, reason: "follow_up_closed" });
    }
  } catch (err) {
    logger.warn("caldav_sync_failed", { followUpId: followUp && followUp.id, error: err.message });
  }
}

// Entfernt den Termin einer Wiedervorlage (z. B. beim Löschen des Leads). Wirft nie.
async function removeFollowUp(followUpId) {
  if (!isEnabled() || !followUpId) return;
  try {
    const status = await deleteEvent(followUpId);
    if (status !== 404) logger.info("caldav_event_removed", { followUpId, reason: "follow_up_deleted" });
  } catch (err) {
    logger.warn("caldav_delete_failed", { followUpId, error: err.message });
  }
}

// Entfernt einen evtl. noch vorhandenen Legacy-Termin (ein-Termin-je-Lead aus
// der Zeit vor der Umstellung). Best-effort, für die Migration/Resync. Wirft nie.
async function removeLead(leadId) {
  if (!isEnabled() || !leadId) return;
  try {
    const res = await caldavFetch("DELETE", legacyEventUrl(leadId));
    if (res.ok && res.status !== 404) logger.info("caldav_legacy_removed", { leadId });
  } catch (err) {
    logger.warn("caldav_delete_failed", { leadId, error: err.message });
  }
}

// Überträgt alle übergebenen offenen Wiedervorlagen in den Kalender (ein Termin
// je Wiedervorlage) – für das nachträgliche Befüllen bzw. eine manuelle
// Resynchronisation aus den Einstellungen. `items` = [{ lead, followUp }].
// Bricht beim ersten Fehler ab und meldet ihn zurück (ein Konfigurationsproblem
// betrifft alle Termine gleich). Wirft nie.
async function syncAll(items, baseUrl = "") {
  if (!isEnabled()) return { enabled: false, candidates: 0, synced: 0, error: "" };
  const list = (Array.isArray(items) ? items : []).filter(
    (it) => it && it.lead && it.followUp && shouldHaveEvent(it.followUp)
  );
  let synced = 0;
  for (const it of list) {
    try {
      await putEvent(it.lead, it.followUp, baseUrl);
      synced++;
    } catch (err) {
      logger.warn("caldav_sync_failed", { followUpId: it.followUp.id, error: err.message, during: "sync_all" });
      return { enabled: true, candidates: list.length, synced, error: err.message };
    }
  }
  logger.info("caldav_sync_all", { candidates: list.length, synced });
  return { enabled: true, candidates: list.length, synced, error: "" };
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
    autoFollowups: AUTO_FOLLOWUPS_ENABLED,
  };
}

module.exports = {
  isEnabled,
  syncFollowUp,
  removeFollowUp,
  removeLead,
  syncAll,
  describe,
  // Für Tests/Diagnose exportiert:
  buildICS,
  shouldHaveEvent,
  uidFor,
  eventUrl,
};
