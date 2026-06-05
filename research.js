"use strict";

// --- Lead-Recherche --------------------------------------------------------
// Bildet den "lead-research"-Skill nach: aus einem Firmennamen oder einer
// Website-URL wird per Web-Recherche ein einheitlich strukturiertes
// Cold-Call-Dossier erstellt. Zweistufig:
//   1) Agentische Recherche mit den serverseitigen Tools web_search/web_fetch
//      → liefert das Markdown-Dossier exakt in der Skill-Struktur.
//   2) Extraktion der Felder aus dem Dossier in ein striktes JSON-Schema,
//      damit das Frontend und die KI-Funktionen damit arbeiten können.

const DEFAULT_MODEL = "claude-opus-4-8";

// Adaptive Thinking nur für Modelle, die es unterstützen (Opus/Sonnet 4.x).
function thinkingFor(model) {
  return /^claude-(opus|sonnet)/.test(model) ? { type: "adaptive" } : undefined;
}

// Serverseitige Tools – laufen vollständig auf Anthropic-Infrastruktur.
const WEB_TOOLS = [
  { type: "web_search_20260209", name: "web_search" },
  { type: "web_fetch_20260209", name: "web_fetch" },
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
- Interpretation (Sektion 3–6) ist erwünscht, muss aber erkennbar auf den belegten Fakten aus 1–2 aufbauen. Spekulation als solche kennzeichnen ("Vermutung:", "Hypothese:").

## Recherche-Vorgehen
Nutze web_search und web_fetch aktiv. Arbeite die Quellen ab und sammle für jede Angabe die Quell-URL:
1. Offizielle Website — Startseite, Leistungen/Angebot, Über uns/Team, Kontakt.
2. Impressum — verlässlichste Quelle für Rechtsform, Inhaber/Geschäftsführer, Anschrift, Telefon, Mail.
3. Google-Unternehmensprofil — Öffnungszeiten, Adresse.
4. Bewertungsportale (Pflicht-Schritt): immer aktiv prüfen — Google Maps/Reviews, Trustpilot, ProvenExpert, Treatwell, Das Örtliche/Gelbe Seiten. Fokus auf negative Rezensionen (Erreichbarkeit, Wartezeiten, Terminchaos → Cold-Call-Hook). Pflicht ist das Durchsuchen, nicht das Finden — nichts erfinden.
5. LinkedIn/Xing — Entscheider verifizieren, Unternehmensgröße abschätzen.
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

## 3. Sichtbare Schwachstellen / Ansatzpunkte
[Konkrete, beobachtbare Schwachstellen. Jede mit Beleg oder als Hypothese gekennzeichnet.]

## 4. Potenziale für FU/GE
[Mindestens 5 konkrete, lead-spezifische Potenziale. Denke vom Betrieb des Leads aus. Jedes setzt auf einem belegten Signal aus 1–3 auf ("Weil [Signal] → [Potenzial]"). Format pro Potenzial:
- **[Kurztitel]** — [was konkret integriert/verbessert/entwickelt wird + Nutzen]. *Signal: [belegtes Signal]. [ggf. "Hypothese."]*]

## 5. Strategie für Cold Call
[Konkreter Gesprächseinstieg. Wer wird angerufen? Welcher Pain-Point-Hook zuerst? Welche Dienstleistung als Aufhänger? Tonalität. 1 starker Opener-Satz.]

## 6. Risiken / Denkbare Ablehnungsgründe
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
    "negativeBewertungen", "einordnung", "schwachstellen", "potenziale",
    "coldCallStrategie", "risiken",
  ],
  additionalProperties: false,
};

// Phase 1: agentische Web-Recherche → Markdown-Dossier.
// Server-Tools laufen in einer serverseitigen Schleife; bei Erreichen des
// Iterationslimits liefert die API stop_reason "pause_turn" und wir setzen fort.
async function runResearch(anthropic, input, model, onProgress) {
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
  for (let i = 0; i < 16; i++) {
    const params = {
      model,
      max_tokens: 16000,
      system: RESEARCH_SYSTEM,
      tools: WEB_TOOLS,
      messages,
    };
    if (thinking) params.thinking = thinking;
    const stream = anthropic.messages.stream(params);

    // Fortschritt melden, sobald die KI eine Web-Suche/Seitenabruf nutzt.
    stream.on("contentBlock", (block) => {
      if (!block || block.type !== "server_tool_use") return;
      const inp = block.input || {};
      if (block.name === "web_search" && inp.query) {
        onProgress(`🔍 Suche: ${inp.query}`);
      } else if (block.name === "web_fetch" && inp.url) {
        onProgress(`🌐 Öffne: ${inp.url}`);
      }
    });

    const msg = await stream.finalMessage();

    if (msg.stop_reason === "pause_turn") {
      // Server hat das interne Tool-Limit erreicht – Assistant-Turn anhängen
      // und erneut senden, der Server nimmt automatisch wieder auf.
      messages.push({ role: "assistant", content: msg.content });
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
  return dossier;
}

// Phase 2: Felder aus dem Dossier in striktes JSON extrahieren.
async function extractFields(anthropic, input, dossier, model) {
  const msg = await anthropic.messages.create({
    model,
    max_tokens: 8000,
    system:
      "Du extrahierst Felder aus einem bereits erstellten Cold-Call-Dossier in das " +
      "geforderte JSON-Format. Übernimm ausschließlich, was im Dossier steht. " +
      "Wenn ein Feld im Dossier 'k.A.' ist oder fehlt, trage 'k.A.' (bzw. leere Quelle) ein. " +
      "Erfinde nichts hinzu.",
    messages: [
      { role: "user", content: `Input: ${input}\n\nDossier:\n\n${dossier}` },
    ],
    output_config: {
      format: { type: "json_schema", schema: RESEARCH_SCHEMA },
    },
  });
  const text = msg.content.find((b) => b.type === "text");
  return JSON.parse(text ? text.text : "{}");
}

// Öffentliche API: vollständige Recherche → strukturiertes Objekt inkl. Markdown.
async function researchCompany(anthropic, input, model = DEFAULT_MODEL, onProgress = () => {}) {
  onProgress(`Starte Recherche zu „${input}“…`);
  const dossier = await runResearch(anthropic, input, model, onProgress);
  onProgress("📝 Dossier erstellt – extrahiere strukturierte Felder…");
  const fields = await extractFields(anthropic, input, dossier, model);
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
