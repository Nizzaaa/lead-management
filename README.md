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

## Schnellstart mit Docker Compose (empfohlen)

```bash
# 1. API-Key hinterlegen (optional, aktiviert die KI-Funktionen)
cp .env.example .env
#   → ANTHROPIC_API_KEY in der .env eintragen

# 2. Bauen und starten
docker compose up -d
```

Dann im Browser öffnen: **http://localhost:3000**

Der Stack startet zwei Container: die **Web-App** und eine **PostgreSQL-Datenbank**.

- Die Leads werden in der PostgreSQL-DB im benannten Volume `leadpilot-db`
  gespeichert und bleiben über Neustarts und Rebuilds hinweg erhalten.
- DB-Passwort über `POSTGRES_PASSWORD` in der `.env` setzen (Standard: `leadpilot`).
- Port anpassen: `PORT=8080 docker compose up -d` (oder `PORT` in der `.env` setzen).
- Stoppen: `docker compose down` · inkl. Daten löschen: `docker compose down -v` ·
  Logs: `docker compose logs -f` · Neu bauen: `docker compose up -d --build`

## Deployment mit Dockge (GHCR-Image)

[Dockge](https://github.com/louislam/dockge) verwaltet Compose-Stacks über eine
Web-Oberfläche und ist auf **fertige Images** ausgelegt. Dafür gibt es das vorgebaute
Image in der **GitHub Container Registry (GHCR)** sowie eine passende Compose-Datei
unter [`dockge/compose.yaml`](dockge/compose.yaml).

**1. Image veröffentlichen** – der Workflow
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) baut und
pusht das Image automatisch nach `ghcr.io/<owner>/leadpilot`:

- Push/Merge auf `main` → `:latest`
- Git-Tag `v1.2.3` → `:1.2.3`, `:1.2`, `:1`
- Manuell über *Actions → Build & Publish → Run workflow* (auf beliebiger Branch)

> Das GHCR-Paket ist anfangs **privat**. Entweder es unter
> *GitHub → Packages → leadpilot → Package settings* auf **public** stellen, oder den
> Docker-Host vorher per `docker login ghcr.io` authentifizieren.

**2. In Dockge anlegen:**

1. **„+ Compose"** klicken, Stack-Name z. B. `leadpilot`.
2. Den Inhalt von [`dockge/compose.yaml`](dockge/compose.yaml) in den Compose-Editor einfügen.
3. Im **`.env`-Editor** die Variablen setzen:
   ```env
   ANTHROPIC_API_KEY=sk-ant-...
   POSTGRES_PASSWORD=einsicheres-passwort
   PORT=3000
   ```
4. **Deploy** klicken – Dockge zieht das Image und startet App + PostgreSQL.

## Schnellstart ohne Docker

Hierfür wird eine erreichbare **PostgreSQL-Datenbank** benötigt:

```bash
# 1. Abhängigkeiten installieren
npm install

# 2. Datenbank-Verbindung setzen
export DATABASE_URL=postgres://leadpilot:leadpilot@localhost:5432/leadpilot

# 3. KI aktivieren (optional, aber empfohlen)
export ANTHROPIC_API_KEY=sk-ant-...

# 4. Starten (Schema wird beim Start automatisch angelegt)
npm start
```

Dann im Browser öffnen: **http://localhost:3000**

> Ohne `ANTHROPIC_API_KEY` läuft die App vollständig – die KI-Buttons sind dann
> einfach inaktiv. Sobald der Key gesetzt ist, erscheinen die KI-Funktionen automatisch.

## Technik

- **Backend:** Node.js + Express
- **Datenbank:** PostgreSQL (Treiber [`pg`](https://www.npmjs.com/package/pg)); das Schema
  wird beim Start automatisch angelegt
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

Alle Leads werden in einer **PostgreSQL-Datenbank** gespeichert. Im Docker-Compose-Setup
liegt diese im Volume `leadpilot-db` und bleibt so dauerhaft erhalten. Die Tabelle `leads`
wird beim ersten Start automatisch angelegt.
