# LeadPilot in Nextcloud einbinden (Zitadel-SSO)

Ziel: LeadPilot **innerhalb der Nextcloud-Oberfläche** anzeigen (als Reiter)
und so absichern, dass es **nur für angemeldete Benutzer** erreichbar ist.
Wer in Nextcloud eingeloggt ist, sieht das Lead-System **ohne zweites Login**.

Zentrale Idee: **Zitadel ist der gemeinsame Identity-Provider** für Nextcloud
*und* LeadPilot. Dadurch teilen sich beide dieselbe Anmeldesitzung (SSO).

```
Browser ──> Nextcloud (cloud.lennartg.de)   [Login via Zitadel]
              │  External Sites (iframe)
              ▼
        leads.lennartg.de ──> oauth2-proxy ──(nur wenn Zitadel-Session)──> LeadPilot
                                    │                                          └─ db
                                    └── OIDC gegen Zitadel (auth.lennartg.de)
```

## Warum SSO und nicht „nur Zugriffsbeschränkung"?

Beim Einbetten per iframe lädt **der Browser des Nutzers** die App direkt –
Nextcloud sitzt nicht in der Verbindung. Eine reine Netzwerk-/IP-Regel
(„nur der Nextcloud-Server darf zugreifen") würde deshalb **alle echten Nutzer
aussperren**. Die wirksame Zugriffskontrolle ist daher die **Authentifizierung
am Proxy** (Forward-Auth/SSO). Als zusätzliche Härtung gilt:

- Die App ist **nicht direkt** exponiert – nur der oauth2-proxy ist erreichbar.
- `Content-Security-Policy: frame-ancestors` (in der App eingebaut, via
  `FRAME_ANCESTORS`) verhindert, dass **andere** Seiten die App einbetten.

## Voraussetzung: gleiche Domain

Nextcloud, LeadPilot und Zitadel sollten unter **derselben Registrar-Domain**
laufen (z. B. `cloud.lennartg.de`, `leads.lennartg.de`, `auth.lennartg.de`).
Dann ist die gesamte SSO-Kette im iframe *same-site* und unabhängig vom
Third-Party-Cookie-Blocking moderner Browser robust.

---

## Schritt 1 – Nextcloud-Login auf Zitadel umziehen

Damit „in Nextcloud eingeloggt = im Lead-System eingeloggt" gilt, muss
Nextcloud sich ebenfalls über Zitadel anmelden.

1. In Zitadel eine **Web-Application** „Nextcloud" anlegen (Projekt z. B.
   „Interne Tools"), Flow **Code**, Auth-Methode **Client Secret**.
   - Redirect-URI: `https://cloud.lennartg.de/apps/user_oidc/code`
2. In Nextcloud die App **„OpenID Connect user backend" (`user_oidc`)**
   installieren und einen Provider anlegen – per UI
   (*Administration → OpenID Connect*) oder per `occ`:

   ```bash
   occ user_oidc:provider Zitadel \
     --clientid="<CLIENT_ID>" \
     --clientsecret="<CLIENT_SECRET>" \
     --discoveryuri="https://auth.lennartg.de/.well-known/openid-configuration" \
     --scope="openid email profile" \
     --mapping-uid=sub --mapping-email=email --mapping-display-name=name \
     --unique-uid=0
   ```

3. Testen: Abmelden → „Mit Zitadel anmelden" → Login läuft über Zitadel.
   (Den lokalen Login kann man später optional ausblenden.)

## Schritt 2 – Zitadel-App für LeadPilot

In Zitadel eine zweite **Web-Application** „LeadPilot" anlegen:

- Flow **Code**, Auth-Methode **Client Secret** (oder PKCE – dann im Compose
  `OAUTH2_PROXY_CODE_CHALLENGE_METHOD=S256` setzen).
- Redirect-URI: `https://leads.lennartg.de/oauth2/callback`
- Post-Logout-URI (optional): `https://leads.lennartg.de/`
- **Client-ID** und **Client-Secret** notieren.

## Schritt 3 – Stack ausrollen

Vorlage: [`deploy/docker-compose.nextcloud.yml`](../deploy/docker-compose.nextcloud.yml)
und [`deploy/.env.example`](../deploy/.env.example).

```bash
cd deploy
cp .env.example .env       # Werte ausfüllen (Domains, Zitadel, Secrets)
# Cookie-Secret erzeugen:
python3 -c 'import os,base64;print(base64.urlsafe_b64encode(os.urandom(32)).decode())'
docker compose -f docker-compose.nextcloud.yml up -d
```

Der Stack startet **db**, **leadpilot** (nur intern) und **oauth2-proxy**
(über Traefik unter `leads.lennartg.de`, TLS). Direktaufruf von
`https://leads.lennartg.de` löst nun den Zitadel-Login aus; danach erscheint
die App.

> TLS ist Pflicht (`Secure`-Cookies). Traefik muss einen Entrypoint
> `websecure` und einen Zertifikats-Resolver haben (`TRAEFIK_CERTRESOLVER`).

## Schritt 4 – Inpage-Rendering in Nextcloud

1. Nextcloud-App **„External sites"** installieren.
2. *Administration → External sites* → Eintrag anlegen:
   - **Name:** LeadPilot
   - **URL:** `https://leads.lennartg.de`
   - **Darstellung:** *in einem iframe anzeigen*

Weil LeadPilot `frame-ancestors 'self' https://cloud.lennartg.de` sendet,
erlaubt der Browser die Einbettung **nur** durch Nextcloud.

## Ergebnis & Identität

- Eingeloggt in Nextcloud (via Zitadel) → das Lead-System lädt im iframe und ist
  durch die bestehende Zitadel-Session **sofort** authentifiziert (stiller
  302-Redirect, keine Login-Maske im iframe).
- oauth2-proxy reicht `X-Forwarded-Email` an die App weiter; LeadPilot
  übernimmt das als **Aktor** in Aktivitäten-Timeline und Aufgaben.

## Stolpersteine

- **Login-Maske erscheint im iframe / wird blockiert:** Es bestand keine aktive
  Zitadel-Session (Nextcloud nutzt noch lokalen Login, oder Session abgelaufen).
  → Schritt 1 umsetzen bzw. Session-Lebensdauer in Zitadel erhöhen.
- **Cookies werden im iframe nicht gesendet:** Hosts liegen auf verschiedenen
  Registrar-Domains. → Alles unter eine Domain bringen, `COOKIE_DOMAIN` prüfen.
- **`redirect_uri` mismatch:** Redirect-URI in der Zitadel-App muss exakt
  `https://leads.lennartg.de/oauth2/callback` lauten.
- **Zitadel rendert seine Seite im iframe nicht (X-Frame-Options):** ist
  beabsichtigt; mit aktiver Session sind es nur 302-Redirects, die nicht
  gerendert werden. Bei Bedarf die App alternativ als eigener Tab statt iframe
  öffnen.

## Checkliste

- [ ] Zitadel-Apps „Nextcloud" und „LeadPilot" angelegt (Redirect-URIs korrekt)
- [ ] Nextcloud meldet sich über Zitadel an (`user_oidc`)
- [ ] `deploy/.env` gefüllt, `COOKIE_SECRET` erzeugt
- [ ] Stack läuft; App ist **nicht** direkt exponiert (nur oauth2-proxy)
- [ ] Hosts unter einer Registrar-Domain, `COOKIE_DOMAIN` passt
- [ ] External-Sites-Eintrag als iframe sichtbar
- [ ] Test: in NC eingeloggt → Lead-System ohne zweites Login sichtbar
