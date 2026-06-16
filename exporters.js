"use strict";

// Import-/Export-Helfer für Leads (CSV und Excel).
//
// Bewusst dependency-frei gehalten: CSV wird von Hand erzeugt/geparst und für
// "Excel" nutzen wir das SpreadsheetML-2003-Format (XML). Excel und LibreOffice
// öffnen diese .xls-Dateien direkt – ohne dass eine ZIP-/XLSX-Bibliothek nötig
// ist. So bleibt der Produktions-Build (npm ci --omit=dev) schlank.

// Spalten der Export-Datei: [Überschrift, Wert-Funktion]. Die Reihenfolge
// bestimmt die Spaltenreihenfolge in CSV und Excel.
const LEAD_COLUMNS = [
  ["Name", (l) => l.name || ""],
  ["Firma", (l) => l.company || ""],
  ["E-Mail", (l) => l.email || ""],
  ["Telefon", (l) => l.phone || ""],
  ["Quelle", (l) => l.source || ""],
  ["Status", (l) => l.status || ""],
  ["Wert", (l) => (l.value != null ? l.value : "")],
  ["Notizen", (l) => l.notes || ""],
  ["Nächster Schritt", (l) => l.nextStep || ""],
  ["Wiedervorlage", (l) => l.nextStepAt || ""],
  ["KI-Score", (l) => (l.ai && l.ai.score != null ? l.ai.score : "")],
  ["KI-Note", (l) => (l.ai && l.ai.grade ? l.ai.grade : "")],
  ["Erstellt", (l) => l.createdAt || ""],
  ["Aktualisiert", (l) => l.updatedAt || ""],
  // Vollständige KI-Bewertung und Recherche-Dossier als JSON – damit ein
  // Export→Import-Durchlauf diese Daten verlustfrei erhält. (KI-Score/KI-Note
  // oben bleiben als gut lesbare Kurzfassung für Excel.)
  ["KI-Bewertung (JSON)", (l) => (l.ai ? JSON.stringify(l.ai) : "")],
  ["Dossier (JSON)", (l) => (l.research ? JSON.stringify(l.research) : "")],
];

// Spalten, die beim Excel-Export numerisch ausgegeben werden.
const NUMERIC_HEADERS = new Set(["Wert", "KI-Score"]);

// Spalten der Prospect-Export-Datei (Discovery-Liste). Eigenes Schema, da
// Prospects ein anderes Datenmodell als Leads haben (Branche/Größe/Potenzial
// statt E-Mail/Wert/Status-Pipeline). "Kriterien (JSON)" hält die
// Discovery-Suchkriterien verlustfrei fest.
const PROSPECT_COLUMNS = [
  ["Name", (p) => p.name || ""],
  ["Website", (p) => p.website || ""],
  ["Domain", (p) => p.domain || ""],
  ["Ort", (p) => p.ort || ""],
  ["Branche", (p) => p.branche || ""],
  ["Größe", (p) => p.groesse || ""],
  ["Potenzial", (p) => p.potenzial || ""],
  ["Potenzial-Grund", (p) => p.potenzialGrund || ""],
  ["Begründung", (p) => p.begruendung || ""],
  ["Quelle", (p) => p.quelle || ""],
  ["Status", (p) => p.status || ""],
  ["Erstellt", (p) => p.createdAt || ""],
  ["Aktualisiert", (p) => p.updatedAt || ""],
  ["Kriterien (JSON)", (p) => (p.kriterien ? JSON.stringify(p.kriterien) : "")],
];

// Erlaubte Überschriften beim Import (klein geschrieben) → internes Feld.
// Akzeptiert deutsche und englische Varianten, damit auch fremde Tabellen
// importiert werden können.
const IMPORT_MAP = {
  "name": "name",
  "firma": "company", "company": "company", "unternehmen": "company",
  "e-mail": "email", "email": "email", "mail": "email", "e mail": "email",
  "telefon": "phone", "phone": "phone", "tel": "phone", "telefonnummer": "phone",
  "quelle": "source", "source": "source",
  "status": "status",
  "wert": "value", "value": "value", "betrag": "value", "umsatz": "value",
  "notizen": "notes", "notes": "notes", "notiz": "notes",
  "nächster schritt": "nextStep", "naechster schritt": "nextStep",
  "nextstep": "nextStep", "next step": "nextStep",
  "wiedervorlage": "nextStepAt", "wiedervorlage am": "nextStepAt",
  "nextstepat": "nextStepAt", "next step at": "nextStepAt",
  // Vollständige KI-Bewertung / Dossier als JSON (für verlustfreien Round-Trip).
  "ki-bewertung (json)": "aiJson", "ki-bewertung": "aiJson", "ai": "aiJson",
  "dossier (json)": "researchJson", "dossier": "researchJson", "research": "researchJson",
};

// --- CSV -------------------------------------------------------------------

// Schützt vor CSV-Formel-Injection (Excel/LibreOffice werten Zellen, die mit
// = + - @ oder Tab/CR beginnen, als Formel aus). Lead-Daten stammen u. a. aus
// der KI-Web-Recherche fremder Websites – also nicht vertrauenswürdig. Solche
// Zellen werden mit einem führenden Apostroph als Text markiert (Excel zeigt
// den Apostroph nicht an). Reine Zahlen bleiben unangetastet.
function neutralizeFormula(s) {
  if (!s) return s;
  if (/^-?\d+(?:[.,]\d+)?$/.test(s)) return s; // echte Zahl: nicht anfassen
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// Maskiert eine Zelle nach RFC 4180 (Anführungszeichen verdoppeln, bei
// Sonderzeichen in Anführungszeichen setzen) – inkl. Formel-Injection-Schutz.
function csvCell(value, delimiter) {
  const s = neutralizeFormula(value == null ? "" : String(value));
  if (s.includes('"') || s.includes("\n") || s.includes("\r") || s.includes(delimiter)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Erzeugt eine CSV aus Zeilen-Objekten anhand einer Spaltendefinition
// [Überschrift, Wert-Funktion]. Default-Trennzeichen ";" (deutsches Excel
// öffnet es ohne Textimport-Assistenten korrekt). Ohne BOM – das ergänzt der
// Aufrufer.
function rowsToCsv(items, columns, delimiter = ";") {
  const lines = [];
  lines.push(columns.map((c) => csvCell(c[0], delimiter)).join(delimiter));
  for (const it of items) {
    lines.push(columns.map((c) => csvCell(c[1](it), delimiter)).join(delimiter));
  }
  return lines.join("\r\n");
}

// CSV aller Leads.
function leadsToCsv(leads, delimiter = ";") {
  return rowsToCsv(leads, LEAD_COLUMNS, delimiter);
}

// CSV aller Prospects (Discovery-Liste).
function prospectsToCsv(prospects, delimiter = ";") {
  return rowsToCsv(prospects, PROSPECT_COLUMNS, delimiter);
}

// Parst CSV-Text in ein Array von Zeilen (jede Zeile = Array von Zellen).
// Robust gegenüber Anführungszeichen, eingebetteten Zeilenumbrüchen und
// verdoppelten Anführungszeichen. Erkennt das Trennzeichen (";" oder ",")
// automatisch aus der Kopfzeile.
function parseCsv(text) {
  if (typeof text !== "string") return [];
  text = text.replace(/^﻿/, ""); // BOM entfernen
  if (!text.trim()) return [];

  const nl = text.search(/\r?\n/);
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  const delimiter =
    firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Wandelt geparste CSV-Zeilen in Lead-Rohobjekte um (nur erkannte Spalten).
// Leere Zeilen werden übersprungen. Liefert { leads, recognized } – recognized
// sind die zugeordneten Überschriften (für eine sprechende Rückmeldung).
function csvRowsToLeads(rows) {
  if (!rows.length) return { leads: [], recognized: [] };
  const header = rows[0].map((h) => String(h || "").trim().toLowerCase());
  const fields = header.map((h) => IMPORT_MAP[h] || null);
  const recognized = fields.filter(Boolean);

  const leads = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells || cells.every((c) => String(c == null ? "" : c).trim() === "")) continue;
    const obj = {};
    fields.forEach((field, c) => {
      if (field) obj[field] = cells[c] != null ? String(cells[c]).trim() : "";
    });
    leads.push(obj);
  }
  return { leads, recognized };
}

// Normalisiert einen Wert-/Zahlenstring aus fremden Tabellen ("5.000 €",
// "5.000,00", "5,000.00") in eine reine Zahl. Best-Effort.
function parseNumber(raw) {
  if (raw == null) return 0;
  let s = String(raw).replace(/[^\d.,-]/g, "").trim();
  if (!s) return 0;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Das letzte Trennzeichen ist das Dezimaltrennzeichen.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    // Komma als Dezimaltrennzeichen interpretieren.
    s = s.replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  } else if (hasDot) {
    // Nur Punkte: als Tausendertrennzeichen behandeln, wenn das Muster passt
    // ("5.000", "1.234.567"). Sonst bleibt der Punkt das Dezimaltrennzeichen.
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// --- Excel (SpreadsheetML 2003) --------------------------------------------

function xmlEsc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c])
  );
}

function xlsxCell(value, type) {
  return `<Cell><Data ss:Type="${type}">${xmlEsc(value)}</Data></Cell>`;
}

// Erzeugt eine Excel-Datei (SpreadsheetML/XML) mit allen Leads.
function leadsToXlsxXml(leads) {
  const head =
    "<Row ss:StyleID=\"sHeader\">" +
    LEAD_COLUMNS.map((c) => xlsxCell(c[0], "String")).join("") +
    "</Row>";

  const body = leads
    .map((l) => {
      const cells = LEAD_COLUMNS.map((c) => {
        const v = c[1](l);
        if (NUMERIC_HEADERS.has(c[0]) && v !== "" && Number.isFinite(Number(v))) {
          return xlsxCell(Number(v), "Number");
        }
        return xlsxCell(v == null ? "" : String(v), "String");
      });
      return "<Row>" + cells.join("") + "</Row>";
    })
    .join("");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"' +
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
    '<Styles>\n' +
    '<Style ss:ID="sHeader"><Font ss:Bold="1"/>' +
    '<Interior ss:Color="#E6ECF5" ss:Pattern="Solid"/></Style>\n' +
    '</Styles>\n' +
    '<Worksheet ss:Name="Leads">\n<Table>\n' +
    head +
    body +
    "\n</Table>\n</Worksheet>\n</Workbook>\n"
  );
}

module.exports = {
  LEAD_COLUMNS,
  PROSPECT_COLUMNS,
  leadsToCsv,
  prospectsToCsv,
  parseCsv,
  csvRowsToLeads,
  parseNumber,
  leadsToXlsxXml,
};
