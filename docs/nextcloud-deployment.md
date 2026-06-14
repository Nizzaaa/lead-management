# LeadPilot in Nextcloud einbinden – Cloudflare Access + Zitadel

Ziel: LeadPilot **innerhalb der Nextcloud-Oberfläche** anzeigen (als Reiter)
und so absichern, dass nur authentifizierte Benutzer Zugriff haben. Wer in
Nextcloud eingeloggt ist, soll das Lead-System möglichst **ohne zweites Login**
sehen.

Euer Setup: Ingress läuft über **Cloudflare Zero Trust Tunnel** für
`*.lennartg.de`; **Zitadel** ist der Identity-Provider (`id.myfu.ge`);
Nextcloud und LeadPilot (mit Traefik) laufen lokal.

```
Browser ──> Cloudflare (Access-Policy + Tunnel) ──> Traefik ──> leadpilot ──> db
                       │                                          (cloud.lennartg.de
                       └── OIDC-Login gegen Zitadel (id.myfu.ge)   bindet per iframe ein)
```

## Warum Auth statt reiner Zugriffsbeschränkung?

Beim Einbetten per iframe lädt **der Browser** die App direkt – eine reine
„nur-Nextcloud-darf-zugreifen"-Netzregel würde echte Nutzer aussperren. Die
wirksame Kontrolle ist die **Authentifizierung an der Cloudflare-Edge**
(Cloudflare Access). Zusätzlich gilt:

- Die App ist lokal nur über Traefik/Tunnel erreichbar (kein offener Port).
- `Content-Security-Policy: frame-ancestors` (in der App via `FRAME_ANCESTORS`)
  erlaubt das Einbetten **nur** durch Nextcloud.

## ⚠️ Wichtig: Domains und das iframe-SSO

Zitadel liegt auf `id.myfu.ge` – einer **anderen Registrar-Domain** als
`lennartg.de`. Für das iframe gilt: Der **per-App-Cookie** von Cloudflare
(`CF_Authorization` auf `leads.lennartg.de`) ist *same-site* zu
`cloud.lennartg.de` und funktioniert im iframe problemlos. Nur der **erste**
Login (Redirect zu Zitadel bzw. zur Cloudflare-Team-Domain) ist im iframe
*cross-site* und kann von Browsern blockiert werden.

**Zwei Wege, das robust zu lösen:**

- **Gold-Standard (empfohlen):** Zitadel zusätzlich unter einer Domain in
  `lennartg.de` erreichbar machen (Zitadel-Feature *Custom Domain*, z. B.
  `id.lennartg.de`). Dann ist die **gesamte** SSO-Kette same-site → das iframe
  meldet sich **vollständig lautlos** an.
- **Ohne Custom Domain:** Funktioniert ebenfalls, aber der **erste** Login pro
  Sitzung muss auf Top-Level passieren (App einmal direkt unter
  `https://leads.lennartg.de` öffnen). Danach lädt das iframe für die Dauer der
  Access-Session nahtlos. Access-Session großzügig setzen (z. B. 24 h–7 Tage).

---

## Schritt 1 – Zitadel als Login-Methode in Cloudflare Access

1. In **Zitadel** eine **Web-Application** „Cloudflare Access" anlegen
   (Projekt z. B. „Interne Tools"), Flow **Code**, Auth-Methode
   **Client Secret** (PKCE optional).
   - Redirect-URI: `https://<dein-team>.cloudflareaccess.com/cdn-cgi/access/callback`
   - **Client-ID** und **Client-Secret** notieren.
2. Im **Cloudflare Zero Trust Dashboard** → *Settings → Authentication →
   Login methods → Add new → OpenID Connect*:
   - **App ID:** Zitadel-Client-ID
   - **Client secret:** Zitadel-Client-Secret
   - **Auth URL:** `https://id.myfu.ge/oauth/v2/authorize`
   - **Token URL:** `https://id.myfu.ge/oauth/v2/token`
   - **Certificate (JWKS) URL:** `https://id.myfu.ge/oauth/v2/keys`
   - **OIDC Claims / Scopes:** `openid`, `email`, `profile`
   - *Test* klicken und einmal gegen Zitadel anmelden.

## Schritt 2 – Cloudflare-Access-Application für LeadPilot

Im Zero Trust Dashboard → *Access → Applications → Add an application →
Self-hosted*:

- **Application domain:** `leads.lennartg.de`
- **Identity providers:** nur Zitadel (Cloudflare-One-Time-PIN ggf. deaktivieren)
- **Session Duration:** großzügig (z. B. 24 h), damit das iframe selten
  re-authentifiziert
- **Policy:** z. B. *Allow* für `emails ending in @myfu.ge` oder eine
  bestimmte Zitadel-Gruppe
- Speichern. Ab jetzt verlangt `leads.lennartg.de` einen Zitadel-Login und
  setzt danach das Cookie `CF_Authorization`.

Cloudflare reicht die Identität als Header **`Cf-Access-Authenticated-User-Email`**
an den Origin durch – LeadPilot übernimmt sie automatisch als **Aktor** in
der Aktivitäten-Timeline.

## Schritt 3 – LeadPilot-Stack ausrollen (Dockge)

Der Stack läuft über **Dockge** mit dem GHCR-Image und der Compose-Datei
[`dockge/compose.yaml`](../dockge/compose.yaml):

1. In Dockge **„+ Compose"**, Inhalt von `dockge/compose.yaml` einfügen.
2. Im **`.env`-Editor** setzen:
   ```env
   POSTGRES_PASSWORD=<sicheres-passwort>
   ANTHROPIC_API_KEY=sk-ant-...                 # optional (KI)
   FRAME_ANCESTORS=https://cloud.lennartg.de
   CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
   CF_ACCESS_AUD=<Application-AUD-Tag>          # siehe Schritt 4
   ```
3. **Deploy** klicken.

Der cloudflared-Tunnel zeigt auf Traefik; Traefik routet `leads.lennartg.de`
(Entrypoint `web`, HTTP) auf die App. TLS macht Cloudflare. `FRAME_ANCESTORS`
erlaubt die iframe-Einbettung nur durch Nextcloud.

## Schritt 4 – Origin absichern (Header-Spoofing verhindern)

LeadPilot **verifiziert das signierte Cloudflare-Access-JWT**
(`Cf-Access-Jwt-Assertion`) kryptografisch gegen Cloudflares Schlüssel
(`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) und übernimmt die
Identität erst nach erfolgreicher Prüfung. Dazu im Stack setzen:

- `CF_ACCESS_TEAM_DOMAIN` = deine Team-Domain, z. B. `<team>.cloudflareaccess.com`.
- `CF_ACCESS_AUD` = der **Application Audience (AUD) Tag** der Access-Application
  (Zero Trust → Access → Applications → LeadPilot → *Overview*).

Sind beide gesetzt, lehnt die App jeden sensiblen API-Zugriff **ohne gültiges
Token mit `403`** ab – selbst wenn jemand den Origin direkt erreicht und den
Klartext-Header `Cf-Access-Authenticated-User-Email` fälscht. Die Aktor-Identität
in der Timeline stammt dann aus dem **verifizierten** Token. (Ohne diese
Variablen bleibt das alte Verhalten – der Header wird vertraut –, nur für rein
interne/lokale Setups gedacht.) Ausgenommen von der Prüfung sind bewusst
`/api/config` (Healthcheck) und `/api/widget` (interner homepage-Abruf).

Zusätzlich weiterhin empfohlen:

- Kein öffentlicher Port/DNS-A-Record direkt auf den Server – nur der Tunnel.
- Traefik-Router nur über den Tunnel erreichbar (kein paralleler Ingress).
- Optional als Härtung: in Traefik/Cloudflare nur Cloudflare-IPs zulassen.

## Schritt 5 – Nextcloud-Login auf Zitadel umstellen

So bekommst du „in Nextcloud eingeloggt = im Lead-System eingeloggt" sauber
hin (gleicher IdP = gleiche Identität). Empfohlen ist die App **`user_oidc`**
(*OpenID Connect user backend*, von Nextcloud gepflegt) – nicht `sociallogin`.

1. In **Zitadel** eine **Web-Application** „Nextcloud" anlegen, Flow **Code**,
   Auth-Methode **Client Secret**.
   - Redirect-URI: `https://cloud.lennartg.de/apps/user_oidc/code`
2. In Nextcloud **`user_oidc`** installieren und einen Provider anlegen –
   per UI (*Administration → OpenID Connect*) oder per `occ`:

   ```bash
   occ user_oidc:provider Zitadel \
     --clientid="<CLIENT_ID>" \
     --clientsecret="<CLIENT_SECRET>" \
     --discoveryuri="https://id.myfu.ge/.well-known/openid-configuration" \
     --scope="openid email profile" \
     --mapping-uid=preferred_username \
     --mapping-email=email \
     --mapping-display-name=name \
     --unique-uid=0
   ```

3. **Bestehende lokale Konten zusammenführen:** Das `--mapping-uid` muss zum
   vorhandenen Nextcloud-Benutzernamen passen, sonst legt `user_oidc` neue
   Konten an. Häufig passt `preferred_username` (Zitadel-Loginname) zum
   NC-Benutzernamen; prüfe das an einem Testkonto, bevor du breit ausrollst.
4. **Lokales Login als Notausgang behalten:** Auch wenn du später automatisch
   zu Zitadel weiterleitest, bleibt der direkte lokale Login über
   `https://cloud.lennartg.de/login?direct=1` erreichbar (für den Fall, dass
   der IdP mal nicht antwortet).
5. (Optional) Automatische Weiterleitung zum IdP aktivieren, damit Nutzer die
   lokale Maske gar nicht sehen (Einstellung in `user_oidc` bzw. per
   `config.php`-Flag, je nach App-Version).

> Hinweis: Nextcloud selbst muss **nicht** hinter Cloudflare Access – es meldet
> sich über `user_oidc` direkt bei Zitadel an. Beide Dienste nutzen damit
> denselben IdP.

## Schritt 6 – Inpage-Rendering in Nextcloud

1. Nextcloud-App **„External sites"** installieren.
2. *Administration → External sites* → Eintrag anlegen:
   - **Name:** LeadPilot
   - **URL:** `https://leads.lennartg.de`
   - **Darstellung:** *in einem iframe anzeigen*

Weil LeadPilot `frame-ancestors 'self' https://cloud.lennartg.de` sendet,
erlaubt der Browser die Einbettung nur durch Nextcloud.

## Troubleshooting

- **iframe bleibt leer / „refused to connect":** Erster Access-Login konnte im
  iframe nicht rendern (cross-site). → Zitadel-Custom-Domain unter
  `lennartg.de` einrichten *oder* App einmal auf Top-Level öffnen.
- **Zweites Login trotz Nextcloud-Session:** Nextcloud-Session ≠
  Cloudflare-Access-Session. Mit der Custom-Domain-Variante entfällt das
  spürbar; sonst Access-Session-Dauer erhöhen.
- **`redirect_uri` mismatch:** Redirect-URIs in Zitadel müssen exakt stimmen
  (Cloudflare-Callback bzw. `…/apps/user_oidc/code`).
- **Aktor ist „—":** Kein `Cf-Access-Authenticated-User-Email` angekommen →
  Access-Application greift nicht bzw. Origin wird am Tunnel vorbei erreicht.

## Checkliste

- [ ] Zitadel-App „Cloudflare Access" angelegt, in Zero Trust als OIDC-Login
- [ ] Access-Application für `leads.lennartg.de` mit Zitadel-Policy
- [ ] Stack läuft (Dockge / `dockge/compose.yaml`), `FRAME_ANCESTORS` gesetzt
- [ ] `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` gesetzt (JWT-Verifikation aktiv)
- [ ] Origin nur über den Tunnel erreichbar (kein paralleler Zugang)
- [ ] Nextcloud-Login über `user_oidc`/Zitadel, UID-Mapping geprüft
- [ ] External-Sites-Eintrag als iframe sichtbar
- [ ] (Empfohlen) Zitadel-Custom-Domain `id.lennartg.de` für lautloses SSO
- [ ] Test: in NC eingeloggt → Lead-System ohne zweites Login sichtbar
