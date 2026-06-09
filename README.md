# 🎯 LeadPilot – Lead-Verwaltung mit KI

Ein einfaches, benutzerfreundliches Online-Tool zur Verwaltung von Vertriebs-Leads –
mit integrierten KI-Funktionen auf Basis von Claude.

## Funktionen

**Lead-Recherche statt Handeingabe** (🔎 nach dem `lead-research`-Skill von FU/GE Solutions)
- Lead anlegen durch Eingabe von **nur einer Website-URL oder einem Firmennamen**
- Die KI recherchiert automatisch per Web-Suche ein vollständiges Cold-Call-Dossier:
  - **Allgemeine Infos** (Branche, Adresse, Telefon, Entscheider/Durchwahl, Öffnungszeiten, Mail, Web, Kundenbewertung) – jede Angabe mit Quelle
  - **Negative Bewertungen → Potenzial**, **Selbstdarstellung**, **sichtbare Schwachstellen**
  - **mind. 5 konkrete FU/GE-Potenziale**, **Cold-Call-Strategie** und **Risiken/Ablehnungsgründe**
- Striktes „Keine-Halluzination"-Prinzip: nur belegte Fakten, sonst `k.A.`
- Jeder Lead hat eine **eigene Detailseite**, die das vollständige Dossier sauber strukturiert und formatiert anzeigt (keine rohe Markdown-Ausgabe); jederzeit neu recherchierbar (🔄)

**Lead-Verwaltung**
- **Schlanke Lead-Karten** in der Übersicht zeigen nur das Wichtigste (Firma, Ansprechpartner, Status, Branche, Wert, KI-Score); ein Klick öffnet die Detailseite
- **Detailseite pro Lead** mit Inline-Bearbeitung von **allem**: Stammdaten *und* sämtliche Recherche-Inhalte (Felder inkl. Quellen, Texte, Potenziale)
- Pipeline-Status: `neu → kontaktiert → qualifiziert → angebot → gewonnen / verloren`
- Manuelles Bearbeiten (Status, Wert, Notizen, Stammdaten), Live-Suche und Status-Filter
- Dashboard mit Kennzahlen: Anzahl Leads, **gewichteter Pipeline-Wert** (Erwartungswert = Σ Wert × Abschlusswahrscheinlichkeit je Status, in den Einstellungen anpassbar), gewonnener Umsatz, Abschlussquote

**KI-Funktionen** – nutzen das Recherche-Dossier als Grundlage
- **⚡ KI-Score** – wird automatisch nach der Recherche ermittelt; bewertet das Abschlusspotenzial von 0–100 inkl. Schulnote, Begründung **und einer Auftragswert-Schätzung** (befüllt den Wert, wenn noch keiner gepflegt ist)
- **✉️ E-Mail-Entwurf** – generiert eine personalisierte Akquise-E-Mail, die an einen belegten Ansatzpunkt anknüpft
- **💡 Empfehlungen** – schlägt die nächsten besten Schritte ("Next Best Action") für den Cold Call vor

> Die Web-Recherche läuft über die serverseitigen Anthropic-Tools `web_search` und `web_fetch`
> und benötigt daher einen gesetzten `ANTHROPIC_API_KEY`.

**Aktivitäten-Timeline** (je Lead)
- Jeder Touchpoint wird festgehalten: **Notiz, Anruf, E-Mail, Termin** (mit Ergebnis)
- **Automatische Einträge** für Systemereignisse: Anlage, Recherche, KI-Score, Status­wechsel, KI-E-Mail/Empfehlung – chronologisch mit Zeit und Aktor

**Berichte** (📊)
- KPIs (Leads, gewichtete Pipeline, gewonnen, Abschlussquote, Ø Auftragswert)
- **Pipeline-Trichter**, **neue Leads je Monat**, **gewonnener Umsatz je Monat** (abhängigkeitsfreie SVG-Charts)
- **Quellen-Performance** (Leads/Gewonnen/Wert je Quelle)

**Betrieb & Sicherheit**
- **Strukturiertes Logging** (JSON-Lines) mit Request-ID, Dauer, Aktor und Redaction sensibler Felder; Level über `LOG_LEVEL`, lesbar mit `LOG_PRETTY=1`
- **Einbettung in Nextcloud** als iframe mit SSO über **Cloudflare Access + Zitadel** (oder alternativ eigener `oauth2-proxy`) – siehe [`docs/nextcloud-deployment.md`](docs/nextcloud-deployment.md) und die fertigen Stacks unter [`deploy/`](deploy/). Der authentifizierte Benutzer (`Cf-Access-Authenticated-User-Email` bzw. Proxy-Header) wird als Aktor in der Timeline übernommen.

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

## Entwicklungs-Workflow (empfohlen)

Nicht in Produktion testen. Der professionelle Ablauf in drei Stufen:

### 1. Lokal entwickeln (Live-Reload, kein Deploy)

```bash
# Startet App + Postgres lokal, Quellcode wird live gemountet.
# Backend-Änderungen → Server startet automatisch neu (nodemon);
# Frontend-Änderungen (public/) → einfach Browser neu laden.
docker compose -f docker-compose.dev.yml up
```

Browser: **http://localhost:3000** · KI optional: `ANTHROPIC_API_KEY` vorab setzen
oder in `.env` hinterlegen. So siehst du Änderungen sofort, ganz ohne Image-Build.

### 2. Feature-Branch → Pull Request → CI

- Auf einem **Branch** arbeiten, nicht direkt auf `main`.
- Pull Request öffnen. Der **CI-Workflow**
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) läuft automatisch:
  Abhängigkeiten installieren, Syntax-Check, und ein **Smoke-Test** (App gegen
  eine Wegwerf-Postgres starten und `/api/config` prüfen).
- Erst wenn CI **grün** ist → mergen. So erreicht kein kaputter Stand `main`.

### 3. Staging → Release auf Produktion

Jeder Merge auf `main` baut automatisch `:latest` (GHCR). Daraus:

1. **Staging** ([`dockge/compose.staging.yaml`](dockge/compose.staging.yaml)) fährt
   `:latest` auf einem eigenen Host/Volume → dort testen.
2. Zufrieden? **Release per Git-Tag** setzen:
   ```bash
   git tag v1.4.0 && git push origin v1.4.0
   ```
   Die Action baut daraufhin `:1.4.0` (+ `:1.4`, `:1`).
3. **Produktion** ([`dockge/compose.yaml`](dockge/compose.yaml)) auf diese Version
   pinnen — im `.env`-Editor von Dockge: `LEADPILOT_TAG=1.4.0` → Stack neu deployen.

So aktualisierst du Prod **bewusst** und kannst jederzeit auf eine bekannte
Version zurück, statt blind `:latest` zu ziehen.

> Optional noch komfortabler: ein **Watchtower**-Container auf dem Server zieht
> neue Images automatisch und startet neu – dann entfällt auch der manuelle
> Dockge-Schritt. (Bewusst nicht aktiviert, damit Prod nicht ungefragt rollt.)

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
| `POST` | `/api/leads/research` | Lead per Recherche anlegen (Body: `{ "input": "website-oder-name" }`) |
| `POST` | `/api/leads/:id/research` | Bestehenden Lead neu recherchieren |
| `POST` | `/api/leads` | Lead manuell anlegen |
| `PUT` | `/api/leads/:id` | Lead aktualisieren |
| `DELETE` | `/api/leads/:id` | Lead löschen |
| `GET` | `/api/stats` | Dashboard-Kennzahlen |
| `POST` | `/api/leads/:id/score` | KI-Bewertung |
| `POST` | `/api/leads/:id/email` | KI-E-Mail-Entwurf |
| `POST` | `/api/leads/:id/insights` | KI-Empfehlung |

## Lizenz

**Proprietär – Alle Rechte vorbehalten.** Nutzung, Kopieren, Forken oder
Weitergabe sind ohne ausdrückliche schriftliche Genehmigung untersagt.
Siehe [`LICENSE`](LICENSE). Anfragen: lennart.gericke@fuge-solutions.de

## Daten

Alle Leads werden in einer **PostgreSQL-Datenbank** gespeichert. Im Docker-Compose-Setup
liegt diese im Volume `leadpilot-db` und bleibt so dauerhaft erhalten. Die Tabelle `leads`
wird beim ersten Start automatisch angelegt.
