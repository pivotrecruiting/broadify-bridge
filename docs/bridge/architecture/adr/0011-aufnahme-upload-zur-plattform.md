# ADR-0011: Aufnahme-Upload zur Plattform

- Status: akzeptiert
- Datum: 2026-11-22
- Verhältnis zu ADR-0008: löst ADR-0008 **nur für den Aufnahme-Upload** ab (die Plattform-Adresse darf dafür aus der
  Release-Konfiguration kommen). Für das Session-Event-Log gilt ADR-0008 unverändert.

## Kontext
Eine fertige Meeting-Aufnahme soll ohne Handarbeit in der Post-Production der Plattform ankommen: die Bridge lädt die
Datei nach dem Stopp im Hintergrund hoch, die Web-App zeigt sie im Eingang und macht daraus mit einem Klick einen
Auftrag.

Der einzige Weg von der Bridge zur Plattform war bisher der Upload des Session-Event-Logs. Den erlaubt ADR-0008 nur auf
Opt-in über die Umgebung (`POSTPRO_API_URL` bzw. `--postpro-api-url`), und ausdrücklich in keinem gepackten Release.
Für den Aufnahme-Upload ist das zu eng: er soll in ausgelieferten Releases funktionieren, sobald die Organisation den
Modus Post-Production gebucht und der Nutzer den Upload eingeschaltet hat.

Aufnahmen sind personenbezogene Daten (Bild und Ton von Menschen) und oft mehrere Gigabyte groß. Daraus folgen die
Anforderungen: nichts verlässt das Gerät ohne Einwilligung; die Bridge darf sich das Ziel nicht von außen vorgeben
lassen; die Datei wird nie in den Speicher geladen; ein Neustart der Bridge oder ein Netzausfall darf den Upload nicht
verlieren; die lokale Datei bleibt unangetastet.

## Entscheidung
1. **In gepackten Releases verfügbar, ohne Umgebungs-Opt-in.** Der Aufnahme-Upload (`apps/bridge/src/services/postpro/`)
   hängt nicht an `POSTPRO_API_URL`. ADR-0008 bleibt für das Session-Event-Log in Kraft: dessen Schalter
   `isSessionLogEnabled()` liest weiter ausschließlich `postproApiUrl`, und kein Release setzt diesen Schlüssel.
2. **Die Plattform-Adresse kommt nur aus vertrauenswürdiger Konfiguration der Bridge**, nie aus einem Relay-Befehl
   (`resolvePlatformApiUrl()` in `config.ts`). Genau zwei Quellen:
   - der release-verwaltete Schlüssel `PRODUCTION_STUDIO_CONTROL_WEBAPP_URL` (je Kanal ins gepackte `.env` geschrieben,
     gewinnt gegen `userData/.env`); der Wert muss die URL-Prüfung der Medien-Befehle bestehen (`parseGuardedUrl`:
     https, Port 443, kein IP-Literal), sonst wird er mit einer festen Warnung verworfen. Anfragen an diese Adresse
     prüfen beim Verbindungsaufbau zusätzlich jede aufgelöste Adresse (`guardedLookup`);
   - die Betreiber-Übersteuerung `POSTPRO_API_URL` / `--postpro-api-url` (Entwicklung; darf http und Loopback sein).
     Sie hat Vorrang.

   Grenzen dieser Zusage (bewusst in Kauf genommen, siehe Folgen):
   - Der release-verwaltete Schlüssel gewinnt nur dann gegen `userData/.env`, wenn das gepackte `.env` ihn setzt
     (`applyReleaseManagedEnvOverrides`). Setzt ein Paket ihn nicht, gilt der Wert aus `userData/.env` oder aus der
     Umgebung des Prozesses; er muss auch dann die URL-Prüfung bestehen.
   - `POSTPRO_API_URL` gehört nicht zu den release-verwalteten Schlüsseln. Steht er in `userData/.env` oder in der
     Umgebung, wirkt er auch in einem gepackten Release, hat Vorrang vor der Release-Adresse und wird nicht geprüft.
     Wer mit den Rechten des Nutzers diese Datei schreiben kann, lenkt damit `begin`/`complete` und über deren
     Antwort die Wahl des Speicher-Endpunkts auf einen eigenen Server (nur öffentliches https mit dem festen Pfad).
   - Eine ungepackte Entwicklungs-Bridge liest denselben Schlüssel `PRODUCTION_STUDIO_CONTROL_WEBAPP_URL`. Trägt
     ihr `.env` die Adresse der Produktion und fehlt `POSTPRO_API_URL`, gehen ihre `begin`-Anfragen (Dateiname,
     Größe, Dauer) an die Produktion, sobald der Hinweis eingeschaltet ist. In der Entwicklung deshalb
     `POSTPRO_API_URL` setzen.

   Der Befehl `meeting_recording_upload_configure` hat ein striktes Schema mit dem einzigen Schlüssel `enabled`; er
   kann weder URL noch Pfad noch Token tragen. Auch die tus-Adresse, die die Plattform bei `begin` nennt, wird geprüft:
   URL-Prüfung wie oben, Pfad genau `/storage/v1/upload/resumable/sign`; die Upload-URL (`Location`) muss denselben
   Ursprung haben.
3. **Standardmäßig aus; die Plattform entscheidet.** Solange die Web-App nicht `enabled: true` geschickt hat, reiht die
   Bridge nichts ein und spricht die Plattform nicht an. Der Wert liegt als Hinweis in
   `<userData>/recording-upload/settings.json` (Standard `false`). Er ist nur eine Optimierung: die Autorität ist der
   Server, der bei jedem `begin` Entitlement, Einwilligung des Nutzers und Monatsgrenzen prüft. Lehnt er mit
   `upload_not_enabled` oder `bridge_not_linked` ab, bricht die Bridge die Aufgabe ab und setzt den Hinweis selbst auf
   `false`. Ein gefälschtes `enabled: true` führt deshalb zu einer abgelehnten Anfrage mit Metadaten (Dateiname, Größe,
   Dauer, Format), nie zu einem Upload.
4. **ProRes-Master bleiben lokal.** Hochgeladen werden nur H.264- und HEVC-Aufnahmen. Eine ProRes-Aufnahme wird
   übersprungen und als `last_skipped.reason = "prores_master_local"` gemeldet. `capabilities.meeting.recording.upload_copy`
   bleibt `false` und für die spätere Upload-Kopie eines ProRes-Masters reserviert; die neue Fähigkeit heißt
   `capabilities.meeting.recording_upload`.
5. **Die lokale Datei wird nur gelesen.** Der Uploader öffnet sie ausschließlich lesend, ändert, verschiebt oder löscht
   sie nie und legt nichts neben sie. Ändert sich die Datei nach dem Einreihen (Größe oder Änderungszeit), endet die
   Aufgabe mit `file_changed`.
6. **Eigener, minimaler tus-Client, fortsetzbar, mit Token-Erneuerung** (`tus-upload-client.ts`, auf `node:https`, keine
   neue Abhängigkeit). Er spricht genau die gegen Supabase Storage geprüfte Teilmenge von tus 1.0: `POST` (anlegen),
   `HEAD` (Offset), `PATCH` (Daten in Stücken der vom Server genannten Größe, vom Datenträger gestreamt). Das
   signierte Upload-Token steht nur im Header `x-signature`, wird nie gespeichert und nie geloggt. Es bleibt in
   Gebrauch, bis es fast abgelaufen ist (Erneuerung über `begin` 10 Minuten vor Ablauf, gerechnet ab dem `begin`,
   das es ausgestellt hat) oder der Speicher es ablehnt. Nicht früher: ob der Speicher ein neu ausgestelltes Token
   auf einem bestehenden Upload annimmt, ist nicht geprüft. Kennt der Speicher die Upload-URL nicht mehr oder nimmt
   er auf ihr kein Token mehr an, beginnt der Upload derselben Datei neu bei Byte 0, je Aufgabe höchstens dreimal;
   danach endet sie mit `upload_restarts_exhausted`. Vor dem letzten Teilstück, mit dem der Speicher das Objekt
   anlegt, fragt die Bridge die Plattform noch einmal per `begin`: eine inzwischen gelöschte Aufnahme
   (`recording_deleted`) wird so nicht mehr fertig hochgeladen.
7. **Dauerhafte Warteschlange, eine Aufgabe zur Zeit, begrenzte Wiederholungen.** `<userData>/recording-upload/queue.json`
   (`services/shared/json-queue-store.ts`, dieselbe Ablage wie die Warteschlange der Conversation Intelligence).
   Wiederholung mit Backoff (30 s bis 30 min); eine Aufgabe endet als `failed` nach 40 Fehlversuchen in Folge ohne
   Byte-Fortschritt, die Plattform oder Speicher mit einem Fehler beantwortet haben, 7 Tage nach dem Einreihen
   (`upload_expired`) oder bei einem endgültigen Fehlercode der Plattform oder des Speichers. Versuche ohne jede
   Antwort (kein Netz) und eine gerade nicht erreichbare Datei (Datenträger nicht eingehängt, Freigabe weg,
   Zugriffsfehler) zählen nicht gegen die 40; sie sind allein durch die 7 Tage begrenzt. Schreibvorgänge der
   Warteschlange laufen nacheinander; eine vorhandene, aber unlesbare Datei wird mit einer Warnung verworfen.
   Integrität: sha256 der ganzen Datei, gestreamt berechnet, bei `complete` gemeldet; der Worker prüft ihn vor der
   Verarbeitung gegen das heruntergeladene Objekt.

## Alternativen
- **Plattform-Adresse per Befehl mitschicken:** jeder, der einen Befehl über das Relay einschleusen kann, könnte
  Aufnahmen an einen fremden Server lenken. Verworfen.
- **Eigener release-verwalteter Schlüssel für PostPro:** hätte die Zusicherung aus ADR-0008 berührt (kein Release
  trägt die PostPro-URL) und einen zweiten Ort für dieselbe Adresse geschaffen. Die Adresse der Web-App ist bereits je
  Kanal release-verwaltet. Verworfen.
- **Upload in einem PUT aus dem Speicher** (wie Session-Log und Conversation Intelligence): bei Dateien von mehreren
  Gigabyte weder speicher- noch netzfest; ein Abbruch bei 95 % begänne von vorn. Verworfen.
- **`tus-js-client` als Abhängigkeit:** der Client braucht ohnehin die geprüfte Verbindung (`guardedLookup`), die
  Token-Erneuerung und die Drosselung; die benötigte Teilmenge ist klein und gegen einen lokalen Testserver
  abgedeckt. Verworfen.
- **`upload_copy` auf `true` setzen:** das Flag hätte dann zwei Bedeutungen (Upload der Aufnahme selbst, Upload-Kopie
  eines ProRes-Masters). Verworfen.
- **Den Hinweis weglassen und nur den Server fragen:** jede ausgelieferte Bridge würde nach jedem Stopp Metadaten der
  Aufnahme an die Plattform schicken, auch ohne Einwilligung. Verworfen.

## Folgen
- Jede Bridge mit Plattform-Adresse und Bridge-ID meldet `capabilities.meeting.recording_upload: true` und legt den
  Uploader an. Ohne `enabled: true` der Web-App geht keine Anfrage an die Plattform; beim Start wird nichts geschrieben.
- Zu einer laufenden Aufnahme liegt ein Eintrag (lokaler Pfad, Codec, Format, Startzeit) in `queue.json`, auch bei
  ausgeschaltetem Upload: so gilt die Einwilligung zum Zeitpunkt des Stopps, und ein Absturz verliert die Aufnahme
  nicht. Beim Stopp wird der Eintrag eingereiht oder entfernt.
- Ausschalten stoppt neues Einreihen. Bereits eingereihte Aufgaben laufen auf der Bridge weiter; ob sie fertig
  werden, entscheidet der Server bei ihrem nächsten `begin` (neuer Versuch, Token-Erneuerung, Neustart des Uploads,
  Rückfrage vor dem letzten Teilstück). Lehnt er mit `upload_not_enabled` ab, endet die Aufgabe als `cancelled`, und
  die Bridge schließt die Zeile der Plattform per `abort`, damit sie im Eingang nicht bis zum Zeitlimit als
  „lädt hoch“ steht. Soll ein laufender Upload nach dem Ausschalten zu Ende laufen, muss der Server bestehende
  Zeilen von der Prüfung der Einwilligung ausnehmen; die Bridge braucht dafür keine Änderung.
- Löscht der Nutzer eine Aufnahme im Eingang, während sie noch hochlädt, erfährt die Bridge das erst beim nächsten
  `begin`, spätestens vor dem letzten Teilstück. Wird während des letzten Teilstücks gelöscht, legt der Speicher das
  Objekt trotzdem an; das Aufräumen dieses Falls ist Sache der Plattform.
- Der Upload beginnt nach dem Stopp und teilt sich die Leitung mit einem laufenden Call. Einzige Stellschraube ist die
  Umgebungsvariable `BRIDGE_RECORDING_UPLOAD_MAX_KBPS` (kbit/s, ohne Wert unbegrenzt); eine Pause während eines Calls
  und eine Einstellung in der Oberfläche gibt es nicht.
- Im Log stehen Dateinamen nur als Basename, dazu Größe, Zustand und Fehlercode; nie Pfad, URL, Token oder
  Antworttext des Speichers.
- Die Übersteuerung `POSTPRO_API_URL` wirkt auch in gepackten Releases (Grenzen unter Entscheidung 2). Das Risiko
  wird in dieser Stufe getragen, weil ein Prozess mit den Rechten des Nutzers die Aufnahmen ohnehin lesen kann.
  Eine Härtung (Übersteuerung in gepackten Releases ignorieren oder ebenfalls prüfen) ist offen.
- Eine Bridge, die 7 Tage lang nicht hochladen konnte, gibt die Aufgabe auf. Die Datei liegt weiter lokal; einen
  manuellen Neuversuch aus der Web-App gibt es in dieser Stufe nicht.
- `scripts/session-log-opt-in-contract.test.cjs` hält beide Seiten fest: die vier Zusicherungen aus ADR-0008
  unverändert, dazu: `isSessionLogEnabled()` liest nur `postproApiUrl`; das Schema des Befehls ist strikt mit dem
  einzigen Schlüssel `enabled`; der Hinweis ist standardmäßig `false`; `config.ts` liest die Plattform-Adresse nur aus
  den zwei genannten Schlüsseln.
