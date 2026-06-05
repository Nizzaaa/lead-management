# 🎯 LeadPilot – Lead-Verwaltung mit KI

Ein einfaches, benutzerfreundliches Online-Tool zur Verwaltung von Vertriebs-Leads –
mit integrierten KI-Funktionen auf Basis von Claude.

## Funktionen

**Lead-Verwaltung**
- Leads anlegen, bearbeiten und löschen (Name, Firma, Kontakt, Quelle, Wert, Notizen)
- Pipeline-Status: `neu → kontaktiert → qualifiziert → angebot → gewonnen / verloren`
- Live-Suche und Status-Filter
- Dashboard mit Kennzahlen: Anzahl Leads, Pipeline-Wert, gewonnener Umsatz, Abschlussquote

**KI-Funktionen** (🤖 über das Anthropic-Modell `claude-opus-4-8`)
- **⚡ KI-Score** – bewertet das Abschlusspotenzial eines Leads von 0–100 inkl. Schulnote und Begründung
- **✉️ E-Mail-Entwurf** – generiert eine personalisierte Akquise-E-Mail (Ziel frei wählbar)
- **💡 Empfehlungen** – schlägt die nächsten besten Schritte ("Next Best Action") vor

## Schnellstart

```bash
# 1. Abhängigkeiten installieren
npm install

# 2. KI aktivieren (optional, aber empfohlen)
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Starten
npm start
```

Dann im Browser öffnen: **http://localhost:3000**

> Ohne `ANTHROPIC_API_KEY` läuft die App vollständig – die KI-Buttons sind dann
> einfach inaktiv. Sobald der Key gesetzt ist, erscheinen die KI-Funktionen automatisch.

## Technik

- **Backend:** Node.js + Express, JSON-Datei als Speicher (`data/leads.json`) – keine Datenbank nötig
- **Frontend:** Vanilla HTML/CSS/JS, kein Build-Schritt
- **KI:** [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) mit `claude-opus-4-8`

## API-Überblick

| Methode | Pfad | Beschreibung |
|--------|------|--------------|
| `GET` | `/api/leads` | Alle Leads |
| `POST` | `/api/leads` | Lead anlegen |
| `PUT` | `/api/leads/:id` | Lead aktualisieren |
| `DELETE` | `/api/leads/:id` | Lead löschen |
| `GET` | `/api/stats` | Dashboard-Kennzahlen |
| `POST` | `/api/leads/:id/score` | KI-Bewertung |
| `POST` | `/api/leads/:id/email` | KI-E-Mail-Entwurf |
| `POST` | `/api/leads/:id/insights` | KI-Empfehlung |

## Daten

Alle Leads werden lokal in `data/leads.json` gespeichert (per `.gitignore` ausgenommen).
