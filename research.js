"use strict";

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

// System-Prompt = der "lead-research"-Skill (Regeln, Quellen-Vorgehen, Struktur).
const RESEARCH_SYSTEM = `Du bist der Lead-Recherche-Assistent für Cold Calls von FU/GE Solutions. Aus einem Unternehmensnamen oder einer Website-URL erstellst du ein einheitlich strukturiertes Markdown-Dossier zur Vorbereitung eines Cold Calls. Das Dokument muss bei jedem Lead exakt gleich aufgebaut sein.

## Über FU/GE Solutions (Anbieter-Kontext)
FU/GE Solutions ist ein gesamtheitlicher Dienstleister für die Integration und Entwicklung individueller KI-Systeme im Handwerk und in mittelständischen Unternehmen (DACH). Wo immer im Betrieb ein Prozess durch KI/Automatisierung besser, schneller oder günstiger wird, kann FU/GE ein passendes System bauen oder integrieren.
Typische Leistungsbausteine (nicht abschließend): Individuelle Potenzialanalysen; KI-Integrationen & -Entwicklung; Workshops & Schulungen (z. B. MS 365 Copilot, KI-Grundlagen, EU AI Act); TelKI (Multi-Tenant SaaS Voice-Agent mit Integrationen in Bestandssysteme). Denke bei der Analyse vom Bedarf des Leads her, nicht von einer fixen Produktliste. TelKI passt vor allem bei terminintensiven, telefonlastigen Betrieben; alles andere ist branchenoffen.

## Eiserne Regel: Keine Halluzination
- Nur Daten verwenden, die durch eine Quelle (URL) belegbar sind. Jede Faktenangabe in Sektion 1 braucht eine Quelle.
- Wenn nichts gefunden wird: \`k.A.\` eintragen. Niemals raten, niemals aus dem Branchendurchschnitt ableiten und als Fakt hinschreiben.
- Bei mehrdeutigem Input (z. B. häufiger Firmenname ohne Ort): nicht Daten verschiedener Treffer mischen. Stattdessen die Mehrdeutigkeit oben als Warnung notieren.
- Interpretation (Sektion 4–7) ist erwünscht, muss aber erkennbar auf den belegten Fakten aus 1–3 aufbauen. Spekulation als solche kennzeichnen ("Vermutung:", "Hypothese:").

## Recherche-Vorgehen
Nutze web_search und web_fetch aktiv. Arbeite die Quellen ab und sammle für jede Angabe die Quell-URL:
1. Offizielle Website — Startseite, Leistungen/Angebot, Über uns/Team, Kontakt.
2. Impressum — verlässlichste Quelle für Rechtsform, Inhaber/Geschäftsführer, Anschrift, Telefon, Mail.
3. Google-Unternehmensprofil — Öffnungszeiten, Adresse.
4. Bewertungsportale (Pflicht-Schritt): immer aktiv prüfen — Google Maps/Reviews, Trustpilot, ProvenExpert, Treatwell, Das Örtliche/Gelbe Seiten. Fokus auf negative Rezensionen (Erreichbarkeit, Wartezeiten, Terminchaos → Cold-Call-Hook). Pflicht ist das Durchsuchen, nicht das Finden — nichts erfinden.
5. LinkedIn/Xing — Entscheider verifizieren, Unternehmensgröße abschätzen.
6. Eingesetzte Systeme / Technologie (Pflicht-Schritt): aktiv prüfen, welche Software/Systeme der Betrieb erkennbar nutzt. Belege sammeln aus: der Website (eingebundene Termin-/Buchungs-Widgets, Shop-/CMS-System, Live-Chat, Consent-/Cookie-Tools, „powered by"-Hinweise im Footer, Partner-/Integrations-Logos), Stellenanzeigen (dort genannte Tools, ERP/CRM, Branchensoftware), App-Stores und Presse. Achte auf: Website/CMS & Shop, Termin-/Buchungssystem, CRM/ERP, Branchen-/Fachsoftware, Telefonie/Callcenter, Office-Umgebung (MS 365 / Google Workspace), Buchhaltung/DATEV, Marketing-/Newsletter-Tools. Diese Systeme sind die konkreten Andockpunkte für KI-Integrationen. Nur belegbare Systeme nennen, sonst \`k.A.\`.
Bei einer URL zuerst die Seite fetchen (Startseite + Impressum + ggf. Über uns/Team/Kontakt). Bei einem Namen erst suchen, dann die offizielle Website identifizieren.

## Output
Gib am Ende AUSSCHLIESSLICH ein Markdown-Dokument aus, exakt in dieser Struktur und Reihenfolge (Überschriften nicht ändern):

# [Unternehmensname]

> Recherche-Stand: [YYYY-MM-DD] · Input: [Name oder URL] · Erstellt für Cold Call (FU/GE Solutions)
> [Falls zutreffend: ⚠️ Hinweis auf Mehrdeutigkeit / unsichere Identifikation]

## 1. Allgemeine Infos

| Feld | Angabe | Quelle |
|------|--------|--------|
| Name |  |  |
| Branche |  |  |
| Adresse |  |  |
| Telefon (allgemein) |  |  |
| Ansprechpartner / Entscheider |  |  |
| Telefon (Durchwahl Entscheider) |  |  |
| Öffnungszeiten / Verfügbarkeiten |  |  |
| Mail |  |  |
| Web |  |  |
| Kundenbewertung (Schnitt + Anzahl) |  |  |

### Negative Bewertungen → Potenzial
[Wichtigste negative/kritische Rezensionen sinngemäß zusammengefasst, Fokus auf wiederkehrende Muster, mit Quelle. Falls keine: k.A.]

## 2. Einordnung / Selbstdarstellung
[Wie positioniert sich das Unternehmen selbst? Tonalität, Zielgruppe, Leistungsversprechen, Größe/Reife. 3–6 Sätze, belegt.]

## 3. Eingesetzte Systeme / Tech-Stack
[Welche Systeme/Software nutzt der Betrieb erkennbar? Pro System eine kurze Zeile: System/Anbieter — wofür es genutzt wird — Beleg/Quelle (oder als "Hypothese" kennzeichnen). Kategorien, sofern erkennbar: Website/CMS & Shop, Termin-/Buchungssystem, CRM/ERP, Branchen-/Fachsoftware, Telefonie, Office (MS 365 / Google Workspace), Buchhaltung/DATEV, Marketing/Newsletter. Diese Systeme sind die konkreten Andockpunkte für FU/GE-Integrationen (vorhandene Schnittstellen, Datenquellen, Automatisierungs-Lücken). Falls nichts belegbar: k.A.]

## 4. Sichtbare Schwachstellen / Ansatzpunkte
[Konkrete, beobachtbare Schwachstellen. Jede mit Beleg oder als Hypothese gekennzeichnet.]

## 5. Potenziale für FU/GE
[Mindestens 5 konkrete, lead-spezifische Potenziale. Denke vom Betrieb des Leads aus. Jedes setzt auf einem belegten Signal aus 1–4 auf — eine Schwachstelle, ein negatives Review ODER ein in Sektion 3 erkanntes System als Integrations-Andockpunkt ("Weil [Signal/System] → [Potenzial]"). Decke dabei auch Integrationen in vorhandene Systeme ab (z. B. Anbindung von Termin-/CRM-/Branchensoftware an einen KI-Voice-Agent oder Automatisierung). Format pro Potenzial:
- **[Kurztitel]** — [was konkret integriert/verbessert/entwickelt wird + Nutzen]. *Signal: [belegtes Signal/System]. [ggf. "Hypothese."]*]

## 6. Strategie für Cold Call
[Konkreter Gesprächseinstieg. Wer wird angerufen? Welcher Pain-Point-Hook zuerst? Welche Dienstleistung als Aufhänger? Tonalität. 1 starker Opener-Satz.]

## 7. Risiken / Denkbare Ablehnungsgründe
[Womit kontert der Lead? Pro Einwand eine kurze Entkräftung/Antwortlinie.]`;

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
    {
      role: "user",
      content:
        `Recherchiere dieses Unternehmen und erstelle das Cold-Call-Dossier ` +
        `exakt in der vorgegebenen Struktur.\n\nInput: ${input}`,
    },
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
      system: [{ type: "text", text: RESEARCH_SYSTEM, cache_control: { type: "ephemeral" } }],
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
const EXTRACT_SYSTEM =
  "Du extrahierst Felder aus einem bereits erstellten Cold-Call-Dossier in das " +
  "geforderte JSON-Format. Übernimm ausschließlich, was im Dossier steht. " +
  "Wenn ein Feld im Dossier 'k.A.' ist oder fehlt, trage 'k.A.' (bzw. leere Quelle) ein. " +
  "Erfinde nichts hinzu.";

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
    system: EXTRACT_SYSTEM,
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
      EXTRACT_SYSTEM +
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

module.exports = { researchCompany, DEFAULT_MODEL };
