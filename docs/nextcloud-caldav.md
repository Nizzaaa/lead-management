# Wiedervorlagen mit einem Nextcloud-Kalender verbinden (CalDAV)

Ziel: Jede **Wiedervorlage** (nächster Schritt + Datum) eines Leads erscheint
automatisch als **Termin in einem Nextcloud-Kalender**. So tauchen fällige
Rückrufe/Follow-ups direkt im gewohnten Kalender (Web, Handy, Outlook-Sync …)
auf – ohne sie doppelt zu pflegen.

## Wie es funktioniert

- **Einseitig (App → Kalender).** LeadPilot ist die Quelle der Wahrheit, der
  Kalender spiegelt nur. Änderungen im Kalender werden **nicht** zurückgelesen.
- **Ein Termin pro Lead.** Der Termin hat eine stabile Kennung aus der Lead-ID
  (`leadpilot-<id>.ics`). Anlegen, Verschieben und Löschen laufen darüber
  idempotent – es entstehen keine Dubletten.
- **Automatisch synchronisiert** bei jeder relevanten Änderung:
  - Wiedervorlage **gesetzt/geändert** (Datum oder Text) → Termin wird
    angelegt bzw. aktualisiert.
  - Wiedervorlage **erledigt/entfernt** → Termin wird gelöscht.
  - Lead **gewonnen/verloren** oder **gelöscht** → Termin wird gelöscht
    (offene Wiedervorlage ist dann gegenstandslos).
- **Best effort.** Ist der Kalender mal nicht erreichbar, schlägt **nur** die
  Kalender-Aktualisierung fehl (wird geloggt) – das Speichern des Leads in
  LeadPilot gelingt trotzdem.

Der Termin trägt als Titel `Wiedervorlage: <Firma> – <nächster Schritt>` und in
der Beschreibung Kontaktdaten, Status, Wert sowie einen **Rücklink zum Lead**.

- **Echte Termine mit Uhrzeit.** Wird eine Aktion (Anruf, E-Mail, Termin oder
  Notiz) mit dem Ergebnis **„Termin vereinbart"** protokolliert, öffnet sich
  sofort eine Maske für
  **Datum + Uhrzeit**. Ein so erfasster Termin (Titel `Termin: <Firma> – …`)
  bekommt eine feste Start-/Endzeit (Dauer aus `CALDAV_EVENT_DURATION_MIN`) und
  **blockt die Verfügbarkeit** (`TRANSP:OPAQUE`). Reine Wiedervorlagen ohne
  Uhrzeit bleiben unverbindliche, transparente Erinnerungen.

## Schritt 1 – CalDAV-Adresse des Kalenders ermitteln

1. In Nextcloud die **Kalender**-App öffnen (ggf. einen eigenen Kalender, z. B.
   „Wiedervorlagen“, anlegen).
2. Beim Kalender auf **„…“ → Link kopieren** (bzw. *CalDAV-Adresse*). Die
   Kollektions-URL hat die Form:

   ```
   https://cloud.example.de/remote.php/dav/calendars/<benutzer>/<kalender>/
   ```

   `<kalender>` ist der interne Slug (klein, ohne Leerzeichen). Der
   **abschließende Schrägstrich** gehört dazu.

## Schritt 2 – App-Passwort in Nextcloud erstellen

Nicht das normale Login-Passwort verwenden (vor allem nicht, wenn der Login
über SSO/Zitadel läuft):

1. In Nextcloud: **Einstellungen → Sicherheit → „App-Passwort/Gerät erstellen“**.
2. Name z. B. `LeadPilot`, **erstellen**, das angezeigte Passwort kopieren.
3. Als `CALDAV_PASSWORD` hinterlegen (siehe unten). Es lässt sich jederzeit
   einzeln widerrufen, ohne andere Logins zu beeinträchtigen.

## Schritt 3 – Umgebungsvariablen setzen

Im Stack (Dockge `.env`-Editor bzw. `.env`, siehe
[`dockge/compose.yaml`](../dockge/compose.yaml)):

```env
CALDAV_URL=https://cloud.example.de/remote.php/dav/calendars/lennart/wiedervorlagen/
CALDAV_USERNAME=lennart
CALDAV_PASSWORD=<das-app-passwort>

# Empfohlen: öffentliche App-URL für den „Lead öffnen“-Link im Termin
APP_BASE_URL=https://leads.example.de

# Optional: statt Ganztags ein Termin mit Uhrzeit + Erinnerung
# CALDAV_EVENT_TIME=09:00
# CALDAV_EVENT_DURATION_MIN=30
# CALDAV_REMINDER_MIN=60
```

Das Passwort lässt sich auch als Docker-Secret bereitstellen – dann statt
`CALDAV_PASSWORD` die Variante `CALDAV_PASSWORD_FILE=/run/secrets/caldav_password`
nutzen (analog zu `ANTHROPIC_API_KEY_FILE`).

Danach den Stack **neu deployen/starten**. Im Start-Log erscheint dann
`"caldav": { "enabled": true, "host": "cloud.example.de", "mode": "all-day", … }`.
In den **Einstellungen** der App zeigt der Abschnitt *📅 Kalender (CalDAV)*
„✅ Verbunden“.

### Optionen

| Variable | Bedeutung | Standard |
| --- | --- | --- |
| `CALDAV_URL` | Kollektions-URL des Zielkalenders (mit `/` am Ende) | – (Pflicht) |
| `CALDAV_USERNAME` | Nextcloud-Benutzername | – (Pflicht) |
| `CALDAV_PASSWORD` | App-Passwort (oder `…_FILE` als Secret) | – (Pflicht) |
| `CALDAV_EVENT_TIME` | Uhrzeit `HH:MM`; leer = **Ganztags-Termin** | leer (Ganztags) |
| `CALDAV_EVENT_DURATION_MIN` | Termindauer in Minuten (nur mit Uhrzeit) | `30` |
| `CALDAV_REMINDER_MIN` | Erinnerung X Minuten vor Beginn (`0` = keine) | `0` |
| `APP_BASE_URL` | öffentliche App-URL für den Rücklink im Termin | aus Request abgeleitet |

> Hinweis zur Zeitzone: Ganztags-Termine sind zeitzonensicher. Mit gesetzter
> Uhrzeit wird eine **lokale** Zeit ohne Zeitzonen-Definition geschrieben
> („floating“); sie zeigt im Kalender genau diese Uhrzeit. Für ein Team in
> einer Zeitzone ist das korrekt.

## Schritt 4 – Netzwerk: Der App-Container muss Nextcloud erreichen

Die Synchronisation läuft **vom LeadPilot-Container aus** per HTTPS zur
`CALDAV_URL`. Der Container muss diese Adresse also erreichen können:

- Läuft Nextcloud öffentlich (z. B. über denselben Cloudflare-Tunnel), genügt
  **ausgehender Internetzugang** des Containers.
- Liegt Nextcloud rein lokal, den App-Container ins selbe Docker-Netz wie
  Nextcloud hängen und dessen **internen** Hostnamen als `CALDAV_URL` nutzen.

Die Härtung des Containers (`read_only`, `cap_drop: ALL`) steht dem nicht im
Weg – es werden nur ausgehende HTTP-Aufrufe gemacht, nichts geschrieben.

## Schritt 5 – Testen

1. Einen Lead öffnen, eine **Wiedervorlage** mit Datum setzen (Detailseite
   oder „📅 Heute“).
2. Im Nextcloud-Kalender erscheint kurz darauf der Termin
   `Wiedervorlage: <Firma> …` am gewählten Tag.
3. Wiedervorlage auf **„✓ Erledigt“** setzen → der Termin verschwindet wieder.

> **Wichtig – nur beim Speichern:** Synchronisiert wird, wenn ein Lead
> angelegt oder geändert wird. **Bestehende** Wiedervorlagen, die schon vor dem
> Einrichten existierten, landen also nicht automatisch im Kalender. Dafür gibt
> es in den **Einstellungen → 📅 Kalender (CalDAV)** den Button
> **„Bestehende Wiedervorlagen jetzt übertragen“** – er schreibt alle offenen
> Wiedervorlagen mit Datum in den Kalender. Schlägt die Verbindung fehl, zeigt
> er den **genauen Grund** (z. B. „HTTP 401“) direkt an – ideal zum Einrichten.

## Troubleshooting

- **Kein Termin, Log zeigt `caldav_sync_failed` mit `HTTP 401`:** Benutzername
  oder App-Passwort falsch (bei SSO unbedingt ein **App-Passwort** verwenden).
- **`HTTP 404` beim Anlegen:** `CALDAV_URL` zeigt nicht auf eine existierende
  Kalender-Kollektion oder der abschließende `/` fehlt. URL erneut aus der
  Kalender-App kopieren.
- **`caldav_sync_failed` mit Timeout/Netzwerkfehler:** Der Container erreicht
  die URL nicht (siehe Schritt 4 – Egress bzw. internes Netz/Hostname).
- **Termin erscheint, aber „Lead öffnen“ fehlt/zeigt ins Leere:**
  `APP_BASE_URL` auf die öffentliche App-URL setzen (z. B.
  `https://leads.example.de`).
- **Status in den Einstellungen bleibt „Nicht konfiguriert“:** Eine der drei
  Pflicht-Variablen ist leer – Stack nach dem Setzen neu starten.
