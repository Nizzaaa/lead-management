"use strict";

// Prompts kommen aus der zentralen, editierbaren Registry (Defaults + Overrides).
const prompts = require("./prompts");

// --- Lead-Recherche --------------------------------------------------------
// Bildet den "lead-research"-Skill nach: aus einem Firmennamen oder einer
// Website-URL wird per Web-Recherche ein einheitlich strukturiertes
// Cold-Call-Dossier erstellt. Zweistufig:
//   1) Agentische Recherche mit den serverseitigen Tools web_search/web_fetch
//      → liefert das Markdown-Dossier exakt in der Skill-Struktur.
//   2) Extraktion der Felder aus dem Dossier in ein striktes JSON-Schema,
//      damit das Frontend und die KI-Funktionen damit arbeiten können.

const DEFAULT_MODEL = "claude-haiku-4-5";

// Phase 2 (Extraktion in JSON) ist eine rein mechanische Aufgabe und läuft
// daher immer auf dem günstigsten Modell – unabhängig vom Recherche-Modell.
// Spart pro Lead spürbar Kosten ohne Qualitätsverlust.
const EXTRACT_MODEL = "claude-haiku-4-5";

// Adaptive Thinking nur für Modelle, die es unterstützen (Opus/Sonnet 4.x).
function thinkingFor(model) {
  return /^claude-(opus|sonnet)/.test(model) ? { type: "adaptive" } : undefined;
}

// Effort-Stufe steuert Denk-Tiefe und damit Token-/Kostenaufwand. "medium" ist
// der Sweet Spot aus Qualität und Effizienz. Wird nur von Opus 4.x und
// Sonnet 4.6 unterstützt (Haiku/Sonnet 4.5 würden einen Fehler werfen).
function effortFor(model) {
  return /^claude-opus/.test(model) || model === "claude-sonnet-4-6" ? "medium" : undefined;
}

// Serverseitige Tools – laufen vollständig auf Anthropic-Infrastruktur.
// Wichtig für niedrige Nutzungs-Tiers (z. B. Tier 1: nur 30.000 Input-Tokens/min
// bei Sonnet): Wir begrenzen Anzahl und Größe der Web-Zugriffe, damit eine
// einzelne Recherche das Minuten-Limit (ITPM) nicht sprengt.
// Stabile GA-Tool-Versionen (ohne „dynamic filtering"). Die neueren
// _20260209-Versionen filtern Inhalte per Code-Execution vor – ist diese
// Umgebung nicht aktiviert, schlagen die Abrufe fehl ("Tools nicht verfügbar").
const WEB_TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  {
    type: "web_fetch_20250910",
    name: "web_fetch",
    max_uses: 5,
    // Deckelt die pro Seite/PDF in den Kontext geladenen Tokens. Ohne Limit
    // kostet eine große Seite schnell ~25.000 und ein PDF ~125.000 Tokens –
    // das allein überschreitet das Tier-1-Limit.
    max_content_tokens: 5000,
  },
];

// Schema für ein Feld aus Sektion 1: belegte Angabe + Quelle.
const fieldSchema = {
  type: "object",
  properties: {
    value: { type: "string", description: "Die Angabe, oder 'k.A.' wenn unbekannt." },
    source: { type: "string", description: "Quell-URL, oder leer." },
  },
  required: ["value", "source"],
  additionalProperties: false,
};

// Striktes Schema für die Extraktion des Dossiers in Felder.
const RESEARCH_SCHEMA = {
  type: "object",
  properties: {
    unternehmensname: { type: "string" },
    rechercheStand: { type: "string", description: "Datum YYYY-MM-DD." },
    ambiguityWarning: { type: "string", description: "Hinweis auf Mehrdeutigkeit, sonst leer." },
    fields: {
      type: "object",
      properties: {
        branche: fieldSchema,
        adresse: fieldSchema,
        telefonAllgemein: fieldSchema,
        ansprechpartner: fieldSchema,
        telefonDurchwahl: fieldSchema,
        oeffnungszeiten: fieldSchema,
        mail: fieldSchema,
        web: fieldSchema,
        kundenbewertung: fieldSchema,
      },
      required: [
        "branche", "adresse", "telefonAllgemein", "ansprechpartner",
        "telefonDurchwahl", "oeffnungszeiten", "mail", "web", "kundenbewertung",
      ],
      additionalProperties: false,
    },
    negativeBewertungen: { type: "string" },
    einordnung: { type: "string" },
    eingesetzteSysteme: {
      type: "string",
      description:
        "Erkennbar eingesetzte Systeme/Software des Betriebs als Andockpunkte für Integrationen (CMS/Shop, Termin-/Buchungssystem, CRM/ERP, Branchensoftware, Telefonie, Office, Buchhaltung, Marketing). 'k.A.', wenn nichts belegbar.",
    },
    schwachstellen: { type: "string" },
    potenziale: {
      type: "array",
      items: {
        type: "object",
        properties: {
          titel: { type: "string" },
          beschreibung: { type: "string" },
          signal: { type: "string" },
        },
        required: ["titel", "beschreibung", "signal"],
        additionalProperties: false,
      },
    },
    coldCallStrategie: { type: "string" },
    risiken: { type: "string" },
  },
  required: [
    "unternehmensname", "rechercheStand", "ambiguityWarning", "fields",
    "negativeBewertungen", "einordnung", "eingesetzteSysteme", "schwachstellen",
    "potenziale", "coldCallStrategie", "risiken",
  ],
  additionalProperties: false,
};

// Setzt genau EINEN rollenden Cache-Breakpoint auf den letzten Content-Block des
// letzten Messages. Vorherige Breakpoints werden entfernt, damit wir das Limit
// von 4 Breakpoints pro Anfrage nicht überschreiten (System-Prompt = 1, hier = 1).
function setRollingCache(messages) {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && typeof b === "object" && b.cache_control) delete b.cache_control;
      }
    }
  }
  const last = messages[messages.length - 1];
  if (last && Array.isArray(last.content) && last.content.length) {
    const block = last.content[last.content.length - 1];
    if (block && typeof block === "object") block.cache_control = { type: "ephemeral" };
  }
}

// Phase 1: agentische Web-Recherche → Markdown-Dossier.
// Server-Tools laufen in einer serverseitigen Schleife; bei Erreichen des
// Iterationslimits liefert die API stop_reason "pause_turn" und wir setzen fort.
async function runResearch(anthropic, input, model, onProgress, signal, onUsage = () => {}) {
  const messages = [
    { role: "user", content: prompts.render("research.user", { input }) },
  ];

  const thinking = thinkingFor(model);
  let dossier = "";
  let toolOk = 0; // erfolgreiche Web-Tool-Ergebnisse (Such-Treffer/Seitenabrufe)
  for (let i = 0; i < 16; i++) {
    const params = {
      model,
      max_tokens: 8000,
      // System-Prompt als cachebarer Block: Tools + System werden über die
      // pause_turn-Fortsetzungen hinweg aus dem Cache gelesen. Cache-Reads
      // zählen NICHT gegen das ITPM-Limit – das senkt die Last bei jeder
      // Fortsetzung erheblich.
      system: [{ type: "text", text: prompts.get("research.system"), cache_control: { type: "ephemeral" } }],
      tools: WEB_TOOLS,
      messages,
    };
    if (thinking) params.thinking = thinking;
    const effort = effortFor(model);
    if (effort) params.output_config = { effort };
    const stream = anthropic.messages.stream(params, { signal });

    // Fortschritt melden: Tool-Aufrufe UND deren Ergebnisse/Fehler.
    stream.on("contentBlock", (block) => {
      if (!block) return;
      if (block.type === "server_tool_use") {
        const inp = block.input || {};
        if (block.name === "web_search" && inp.query) onProgress(`🔍 Suche: ${inp.query}`);
        else if (block.name === "web_fetch" && inp.url) onProgress(`🌐 Öffne: ${inp.url}`);
        return;
      }
      if (block.type === "web_search_tool_result" || block.type === "web_fetch_tool_result") {
        const c = block.content;
        if (Array.isArray(c)) {
          // web_search liefert bei Erfolg ein Array von Treffern.
          toolOk++;
          onProgress(`✓ ${c.length} Treffer gefunden`);
        } else if (c && typeof c === "object" && typeof c.type === "string" && c.type.endsWith("_error")) {
          onProgress(`⚠️ Abruf fehlgeschlagen (${c.error_code || "Fehler"})`);
        } else if (c) {
          // web_fetch liefert bei Erfolg ein Dokument-Objekt.
          toolOk++;
          onProgress("✓ Seite geladen");
        }
      }
    });

    const msg = await stream.finalMessage();
    try { onUsage({ model, kind: "research", usage: msg.usage }); } catch {}

    if (msg.stop_reason === "pause_turn") {
      // Server hat das interne Tool-Limit erreicht – Assistant-Turn anhängen
      // und erneut senden, der Server nimmt automatisch wieder auf.
      messages.push({ role: "assistant", content: msg.content });
      // Rollenden Cache-Breakpoint auf den zuletzt angehängten Turn setzen, damit
      // der wachsende Verlauf (inkl. der großen Tool-Ergebnisse) bei der nächsten
      // Anfrage aus dem Cache gelesen wird statt erneut als Input zu zählen.
      setRollingCache(messages);
      onProgress("… recherchiere weiter");
      continue;
    }

    dossier = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    break;
  }

  if (!dossier) throw new Error("Recherche lieferte kein Dossier.");
  // Ohne ein einziges erfolgreiches Web-Tool-Ergebnis ist das Dossier nicht
  // belegt (häufig: Rate-Limit/Tools nicht verfügbar). Dann lieber sauber
  // abbrechen, statt einen leeren Lead anzulegen.
  if (toolOk === 0) {
    throw new Error(
      "Web-Recherche lieferte keine Ergebnisse – die Such-/Abruf-Tools waren nicht erreichbar " +
        "(oft Rate-Limit auf niedrigem Tier oder die Seite blockiert den Abruf). Bitte erneut " +
        "versuchen oder das Modell wechseln (Haiku/Opus haben höhere Limits)."
    );
  }
  return dossier;
}

// Phase 2: Felder aus dem Dossier in striktes JSON extrahieren.
// (Der Extraktions-System-Prompt lebt in der Registry: "research.extract.system".)

// Robustes Parsen: entfernt ```-Codefences und reduziert notfalls auf das
// äußerste {...}-Objekt. Gibt null zurück, wenn nichts Gültiges gefunden wird.
function parseJsonLoose(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a !== -1 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch {}
  }
  return null;
}

// Liest die JSON-Antwort eines Extraktions-Calls defensiv aus. Wirft mit klarer
// Meldung statt still ein leeres Objekt zu liefern (sonst: leeres Dossier).
function readExtractionJson(msg, label) {
  if (msg.stop_reason === "max_tokens") {
    throw new Error(`${label} wurde abgeschnitten (max_tokens) – Dossier zu groß.`);
  }
  const raw = (msg.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} lieferte kein gültiges JSON.`);
  }
  return parsed;
}

// Versuch via Structured Outputs (json_schema erzwingt valides JSON).
async function extractStructured(anthropic, input, dossier, model, signal, onUsage = () => {}) {
  const msg = await anthropic.messages.create({
    model,
    max_tokens: 16000,
    system: prompts.get("research.extract.system"),
    messages: [{ role: "user", content: `Input: ${input}\n\nDossier:\n\n${dossier}` }],
    output_config: { format: { type: "json_schema", schema: RESEARCH_SCHEMA } },
  }, { signal });
  try { onUsage({ model, kind: "research-extract", usage: msg.usage }); } catch {}
  return readExtractionJson(msg, "Strukturierte Extraktion");
}

// Fallback ohne Structured Outputs: explizite JSON-Anweisung + defensives Parsen.
// Greift, falls die json_schema-Ausgabe in der Umgebung nicht greift.
async function extractPlain(anthropic, input, dossier, model, signal, onUsage = () => {}) {
  const msg = await anthropic.messages.create({
    model,
    max_tokens: 16000,
    system:
      prompts.get("research.extract.system") +
      " Antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt nach diesem Schema " +
      "(keine Erklärungen, kein Markdown, keine Codefences):\n" +
      JSON.stringify(RESEARCH_SCHEMA),
    messages: [{ role: "user", content: `Input: ${input}\n\nDossier:\n\n${dossier}` }],
  }, { signal });
  try { onUsage({ model, kind: "research-extract", usage: msg.usage }); } catch {}
  return readExtractionJson(msg, "JSON-Extraktion");
}

// Extraktion mit Wiederholungen: zweimal strukturiert, dann der Klartext-Fallback.
// Schlägt erst nach allen Versuchen fehl – verhindert ein still leeres Dossier.
async function extractFields(anthropic, input, dossier, model, signal, onUsage = () => {}) {
  const attempts = [
    () => extractStructured(anthropic, input, dossier, model, signal, onUsage),
    () => extractStructured(anthropic, input, dossier, model, signal, onUsage),
    () => extractPlain(anthropic, input, dossier, model, signal, onUsage),
  ];
  let lastErr;
  for (const attempt of attempts) {
    if (signal && signal.aborted) throw new Error("Recherche abgebrochen.");
    try {
      return await attempt();
    } catch (err) {
      if (signal && signal.aborted) throw err;
      lastErr = err;
    }
  }
  throw new Error(
    `Feld-Extraktion fehlgeschlagen: ${lastErr ? lastErr.message : "unbekannt"}`
  );
}

// Öffentliche API: vollständige Recherche → strukturiertes Objekt inkl. Markdown.
async function researchCompany(anthropic, input, model = DEFAULT_MODEL, onProgress = () => {}, signal, onUsage = () => {}) {
  onProgress(`Starte Recherche zu „${input}“…`);
  const dossier = await runResearch(anthropic, input, model, onProgress, signal, onUsage);
  onProgress("📝 Dossier erstellt – extrahiere strukturierte Felder…");
  // Extraktion bewusst auf dem günstigen Modell (mechanische Aufgabe).
  const fields = await extractFields(anthropic, input, dossier, EXTRACT_MODEL, signal, onUsage);
  onProgress("✅ Recherche abgeschlossen.");
  return {
    ...fields,
    input,
    markdown: dossier,
    model,
    recherchiertAm: new Date().toISOString(),
  };
}

// --- Lead-Discovery --------------------------------------------------------
// Findet anhand von Kriterien REALE Unternehmen als Lead-Kandidaten. Gleiche
// zweistufige Mechanik wie die Recherche: (1) agentische Web-Suche → Markdown-
// Liste, (2) Extraktion in striktes JSON. Liefert nur Kandidaten – das Anlegen
// als Lead erfolgt erst über die normale Recherche der ausgewählten Treffer.
// (Der Discovery-System-Prompt lebt in der Registry: "discovery.system".)

// Striktes Schema für die Extraktion der Kandidatenliste.
const DISCOVERY_SCHEMA = {
  type: "object",
  properties: {
    kandidaten: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          website: { type: "string", description: "Domain/URL oder 'k.A.'." },
          ort: { type: "string" },
          branche: { type: "string", description: "Kurze Branchenbezeichnung (z. B. 'Dachdecker', 'Steuerberatung')." },
          groesse: { type: "string", enum: ["1–10", "11–50", "51–200", "201–1000", "1000+", "k.A."], description: "Geschätzte Mitarbeiter-Größenklasse." },
          potenzial: { type: "string", enum: ["A", "B", "C", "D"], description: "Erstbewertung Fit zu FU/GE: A=sehr hoch … D=gering." },
          potenzialGrund: { type: "string", description: "1 kurzer Satz zur Potenzial-Einschätzung (belegtes Signal)." },
          begruendung: { type: "string", description: "1 Satz: warum passend (Signal)." },
          quelle: { type: "string", description: "Quell-URL oder leer." },
        },
        required: ["name", "website", "ort", "branche", "groesse", "potenzial", "potenzialGrund", "begruendung", "quelle"],
        additionalProperties: false,
      },
    },
  },
  required: ["kandidaten"],
  additionalProperties: false,
};

// Kriterien-Objekt → Klartext für den Prompt.
function formatCriteria(c = {}) {
  const lines = [];
  if (c.branche) lines.push(`Branche: ${c.branche}`);
  if (c.region) lines.push(`Region/Ort: ${c.region}`);
  if (c.groesse) lines.push(`Unternehmensgröße: ${c.groesse}`);
  if (c.stichworte) lines.push(`Stichworte/Signale: ${c.stichworte}`);
  if (c.freitext) lines.push(`Weitere Wünsche: ${c.freitext}`);
  const n = Number(c.anzahl) > 0 ? Math.min(25, Math.round(Number(c.anzahl))) : 10;
  lines.push(`Anzahl gewünschter Treffer: ${n}`);
  return lines.join("\n");
}

// Phase 1: agentische Web-Suche → Markdown-Liste (analog runResearch).
async function runDiscovery(anthropic, criteriaText, model, onProgress, signal, onUsage = () => {}) {
  const messages = [{
    role: "user",
    content: prompts.render("discovery.user", { criteria: criteriaText }),
  }];
  const thinking = thinkingFor(model);
  let listText = "";
  let toolOk = 0;
  for (let i = 0; i < 16; i++) {
    const params = {
      model,
      max_tokens: 8000,
      system: [{ type: "text", text: prompts.get("discovery.system"), cache_control: { type: "ephemeral" } }],
      tools: WEB_TOOLS,
      messages,
    };
    if (thinking) params.thinking = thinking;
    const effort = effortFor(model);
    if (effort) params.output_config = { effort };
    const stream = anthropic.messages.stream(params, { signal });
    stream.on("contentBlock", (block) => {
      if (!block) return;
      if (block.type === "server_tool_use") {
        const inp = block.input || {};
        if (block.name === "web_search" && inp.query) onProgress(`🔍 Suche: ${inp.query}`);
        else if (block.name === "web_fetch" && inp.url) onProgress(`🌐 Öffne: ${inp.url}`);
        return;
      }
      if (block.type === "web_search_tool_result" || block.type === "web_fetch_tool_result") {
        const c = block.content;
        if (Array.isArray(c)) { toolOk++; onProgress(`✓ ${c.length} Treffer gefunden`); }
        else if (c && typeof c === "object" && typeof c.type === "string" && c.type.endsWith("_error")) onProgress(`⚠️ Abruf fehlgeschlagen (${c.error_code || "Fehler"})`);
        else if (c) { toolOk++; onProgress("✓ Seite geladen"); }
      }
    });
    const msg = await stream.finalMessage();
    try { onUsage({ model, kind: "discovery", usage: msg.usage }); } catch {}
    if (msg.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: msg.content });
      setRollingCache(messages);
      onProgress("… suche weiter");
      continue;
    }
    listText = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    break;
  }
  if (!listText) throw new Error("Discovery lieferte keine Liste.");
  if (toolOk === 0) {
    throw new Error(
      "Web-Suche lieferte keine Ergebnisse – die Such-Tools waren nicht erreichbar " +
        "(oft Rate-Limit auf niedrigem Tier). Bitte erneut versuchen oder das Modell wechseln."
    );
  }
  return listText;
}

// Phase 2: Kandidaten aus der Liste in striktes JSON extrahieren (mit Fallback).
async function extractCandidates(anthropic, listText, model, signal, onUsage = () => {}) {
  const sys = prompts.get("discovery.extract.system");
  const userText = `Liste:\n\n${listText}`;
  const tryStructured = async () => {
    const msg = await anthropic.messages.create({
      model, max_tokens: 8000, system: sys,
      messages: [{ role: "user", content: userText }],
      output_config: { format: { type: "json_schema", schema: DISCOVERY_SCHEMA } },
    }, { signal });
    try { onUsage({ model, kind: "discovery-extract", usage: msg.usage }); } catch {}
    return readExtractionJson(msg, "Discovery-Extraktion");
  };
  const tryPlain = async () => {
    const msg = await anthropic.messages.create({
      model, max_tokens: 8000,
      system: sys + " Antworte AUSSCHLIESSLICH mit einem JSON-Objekt nach diesem Schema " +
        "(keine Erklärungen, kein Markdown, keine Codefences):\n" + JSON.stringify(DISCOVERY_SCHEMA),
      messages: [{ role: "user", content: userText }],
    }, { signal });
    try { onUsage({ model, kind: "discovery-extract", usage: msg.usage }); } catch {}
    return readExtractionJson(msg, "Discovery-Extraktion (Text)");
  };
  let lastErr;
  for (const attempt of [tryStructured, tryStructured, tryPlain]) {
    if (signal && signal.aborted) throw new Error("Discovery abgebrochen.");
    try { return await attempt(); } catch (err) { if (signal && signal.aborted) throw err; lastErr = err; }
  }
  throw new Error(`Kandidaten-Extraktion fehlgeschlagen: ${lastErr ? lastErr.message : "unbekannt"}`);
}

// Öffentliche API: Discovery → { kriterien, kandidaten[], markdown, model, recherchiertAm }.
async function discoverCompanies(anthropic, criteria, model = DEFAULT_MODEL, onProgress = () => {}, signal, onUsage = () => {}) {
  onProgress("Starte Lead-Discovery…");
  const listText = await runDiscovery(anthropic, formatCriteria(criteria), model, onProgress, signal, onUsage);
  onProgress("📝 Treffer gefunden – extrahiere Kandidaten…");
  const extracted = await extractCandidates(anthropic, listText, EXTRACT_MODEL, signal, onUsage);
  const kandidaten = Array.isArray(extracted.kandidaten) ? extracted.kandidaten : [];
  onProgress(`✅ Discovery abgeschlossen: ${kandidaten.length} Kandidaten.`);
  return { kriterien: criteria, kandidaten, markdown: listText, model, recherchiertAm: new Date().toISOString() };
}

module.exports = { researchCompany, discoverCompanies, DEFAULT_MODEL };
