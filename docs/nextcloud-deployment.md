# LeadPilot in Nextcloud einbinden

Ziel: LeadPilot **innerhalb der Nextcloud-Oberfläche** anzeigen (als Reiter in
der Navigation) und so absichern, dass die App **ausschließlich für angemeldete
Nextcloud-Benutzer** erreichbar ist – ohne eigenes Login im Lead-Tool.

Das gelingt mit zwei Bausteinen:

1. **Inpage-Rendering** über die Nextcloud-App *External Sites* (iframe).
2. **Zugriffsschutz** über einen vorgeschalteten `oauth2-proxy`, der jeden
   Request gegen Nextcloud (als OIDC-Provider) authentifiziert (SSO).

```
Browser ──> Nextcloud (cloud.firma.de)
              │  External Sites (iframe)
              ▼
        leads.firma.de ──> oauth2-proxy ──(nur wenn eingeloggt)──> LeadPilot
                                  │
                                  └── OIDC-Login gegen Nextcloud
```

> **Wichtig – gleiche Domain:** LeadPilot auf eine **Subdomain derselben
> Registrar-Domain** legen wie Nextcloud (z. B. `cloud.firma.de` +
> `leads.firma.de`). Beide teilen die Site `firma.de`, dadurch gelten die
> SSO-Cookies im iframe als *same-site* und der Login funktioniert nahtlos.
> Auf getrennten Domains blockieren moderne Browser die Cookies im iframe.

---

## 1. Nextcloud als OIDC-Provider

1. In Nextcloud die App **„OpenID Connect Identity Provider"** (`oidc`)
   installieren und aktivieren.
2. Unter *Administrationseinstellungen → Sicherheit → OpenID Connect* einen
   **Client** anlegen:
   - **Redirect-URI:** `https://leads.firma.de/oauth2/callback`
   - **Client-ID** und **Client-Secret** notieren.
3. Discovery-/Issuer-URL ist in der Regel:
   `https://cloud.firma.de/index.php/apps/oidc` (je nach Version; die genaue
   `.well-known/openid-configuration` wird in den App-Einstellungen angezeigt).

## 2. oauth2-proxy + LeadPilot per Docker Compose

`docker-compose.nextcloud.yml` (Beispiel):

```yaml
services:
  leadpilot:
    image: ghcr.io/<owner>/leadpilot:latest
    environment:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      PGHOST: db
      PGUSER: leadpilot
      PGPASSWORD: ${POSTGRES_PASSWORD}
      PGDATABASE: leadpilot
      # Einbettung in Nextcloud erlauben:
      FRAME_ANCESTORS: https://cloud.firma.de
      LOG_LEVEL: info
    depends_on: [db]
    # KEIN Port nach außen – nur der Proxy erreicht die App.
    expose: ["3000"]

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: leadpilot
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: leadpilot
    volumes: ["leadpilot-db:/var/lib/postgresql/data"]

  oauth2-proxy:
    image: quay.io/oauth2-proxy/oauth2-proxy:latest
    command:
      - --http-address=0.0.0.0:4180
      - --upstream=http://leadpilot:3000
      - --provider=oidc
      - --oidc-issuer-url=https://cloud.firma.de/index.php/apps/oidc
      - --client-id=${OIDC_CLIENT_ID}
      - --client-secret=${OIDC_CLIENT_SECRET}
      - --redirect-url=https://leads.firma.de/oauth2/callback
      - --cookie-secret=${COOKIE_SECRET}      # 32 zufällige Bytes, base64
      - --cookie-domain=.firma.de             # für same-site im iframe
      - --cookie-samesite=none
      - --cookie-secure=true
      - --email-domain=*
      - --pass-user-headers=true              # X-Forwarded-User/-Email an App
      - --set-xauthrequest=true
    ports:
      - "443:4180"   # in der Praxis hinter einem TLS-Reverse-Proxy (Caddy/Traefik)

volumes:
  leadpilot-db:
```

`.env` dazu:

```env
ANTHROPIC_API_KEY=sk-ant-...
POSTGRES_PASSWORD=ein-sicheres-passwort
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
COOKIE_SECRET=...   # z. B.  openssl rand -base64 32
```

> TLS (HTTPS) sollte ein Reverse Proxy (Caddy, Traefik, nginx) davor
> terminieren. `--cookie-secure=true` setzt zwingend HTTPS voraus.

## 3. Inpage-Rendering in Nextcloud

1. Nextcloud-App **„External sites"** installieren.
2. Unter *Administrationseinstellungen → External sites* einen Eintrag anlegen:
   - **Name:** LeadPilot
   - **URL:** `https://leads.firma.de`
   - **Darstellung:** *„in einem iframe anzeigen"* (damit es inpage erscheint)
   - Icon/Gerätesichtbarkeit nach Bedarf.

Da LeadPilot den Header `Content-Security-Policy: frame-ancestors 'self'
https://cloud.firma.de` sendet (gesetzt über `FRAME_ANCESTORS`), erlaubt der
Browser die Einbettung **nur** durch Nextcloud.

## 4. Benutzer-Identität in LeadPilot

`oauth2-proxy` reicht die Identität als Header weiter
(`X-Forwarded-Email` / `X-Forwarded-User`). LeadPilot liest diese automatisch
und schreibt sie als **Aktor** in die Aktivitäten-Timeline und an Aufgaben
(„wer hat was angelegt/erledigt"). Ohne vorgeschalteten Proxy bleibt das Feld
leer (`—`) und die App läuft unverändert weiter.

## Checkliste

- [ ] `oidc`-App in Nextcloud aktiv, Client mit Redirect-URI angelegt
- [ ] LeadPilot + DB + oauth2-proxy laufen, App ist **nicht** direkt exponiert
- [ ] `FRAME_ANCESTORS` zeigt auf die Nextcloud-Origin
- [ ] LeadPilot läuft auf einer Subdomain derselben Domain wie Nextcloud
- [ ] TLS aktiv, Cookies `Secure` + `SameSite=None`
- [ ] External-Sites-Eintrag als iframe sichtbar
