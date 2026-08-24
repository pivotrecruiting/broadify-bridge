# Datenschutzhinweise — broadify Bridge (WebApp, Bridge, Relay)

Stand: 24. August 2026 · Dokumentversion 2.0 · Bezugsstand der Software: broadify Bridge v0.25.2

> Verbindlichkeitshinweis: Alle technischen Aussagen sind aus dem Quellcode der Version v0.25.2 abgeleitet und verifiziert; Speicher- und Übertragungswege sind mit Quellenangabe im „Technischen Anhang" dokumentiert. Mit `[…]` markierte Angaben sind vor Veröffentlichung festzulegen. Englische Fassung: `docs/legal/en/privacy-notice-broadify-bridge.md`.

## 1. Gegenstand

Diese Hinweise beschreiben die Verarbeitung personenbezogener Daten bei Nutzung der Desktop-Software **broadify Bridge** (Produktlinien broadifyStudio, broadifyMeeting, broadifyConference), der zugehörigen **WebApp** (app.broadify.de) und des **Relay-Dienstes**, der Steuerkommandos zwischen WebApp und installierter Software vermittelt. Sie ergänzen die Datenschutzhinweise für Website, WebApp-Konto/Abrechnung und Zahlungsabwicklung.

## 2. Verantwortlicher

Verantwortlicher (Art. 4 Nr. 7 DSGVO): **[LEGAL_ENTITY_NAME] · [ADDRESS] · [EMAIL_PRIVACY]** · Datenschutzkontakt/DSB: **[DPO_CONTACT]**

Bei produktiver B2B-Nutzung verarbeitet broadify Inhalts- und Betriebsdaten regelmäßig **im Auftrag des Kunden** (Art. 28 DSGVO); ein Auftragsverarbeitungsvertrag wird bereitgestellt: **[AVV-Referenz]**. Für Konto-, Lizenz-, Abrechnungs- und Sicherheitsprozesse ist broadify Verantwortlicher.

## 3. Leitprinzip: Lokale Verarbeitung von Video und Audio

Die Kernverarbeitung der Software erfolgt **vollständig auf dem Endgerät**:

- Kamerabild-Erfassung, Personen-Freistellung (KI-Segmentierung mit lokal mitgelieferten Modellen), Hintergrund-/Inhaltseinblendung und die Bereitstellung als virtuelle Kamera laufen ausschließlich lokal. Der native Verarbeitungsprozess besitzt **keinerlei ausgehende Netzwerkverbindungen**; seine Schnittstellen sind an die lokale Maschine (Loopback bzw. lokaler Speicher) gebunden.
- Aufzeichnungen werden als MP4-Datei **lokal** gespeichert (Standard: Ordner „Filme"/„Videos" des Nutzers bzw. vom Nutzer gewählter Pfad). Es existiert kein Code-Pfad, der Aufzeichnungen, Kamerabilder oder Ton an broadify überträgt.
- Video-, Audio- und Bilddaten verlassen das Gerät über broadify-Infrastruktur **nicht**. Über das Relay werden ausschließlich Steuer- und Status-Nachrichten im JSON-Format übertragen.

## 4. Kategorien verarbeiteter Daten, Zwecke, Rechtsgrundlagen

### 4.1 Konto- und Organisationsdaten (WebApp)

Benutzerkonto, Rollen/Berechtigungen, Organisationszugehörigkeit, Plan-/Lizenzstatus. Zweck: Vertragserfüllung, Zugriffskontrolle. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO. Details in den Datenschutzhinweisen der WebApp.

### 4.2 Geräte- und Verbindungsdaten (Bridge/Relay)

- **Bridge-ID**: lokal erzeugte Zufalls-UUID (kein Hardware-Bezug), **Bridge-Name**: vom Nutzer frei vergeben, **App-Version**, Protokollversion und Sitzungs-UUID. Diese Daten werden beim Verbindungsaufbau an das Relay übermittelt. Die Software überträgt **keinen Rechnernamen (Hostname), keine Benutzernamen und keine Hardware-Seriennummern** an das Relay.
- **Verbindungsprotokoll**: Beginn/Ende der Relay-Verbindung je Bridge (Tabelle `relay_bridge_sessions`: Bridge-ID, Sitzung, Region, Zeitstempel). Zweck: Betrieb, Zustellbarkeit, Sicherheit. Rechtsgrundlage: Art. 6 Abs. 1 lit. b, f DSGVO.
- **Organisationszuordnung**: Zuordnung Bridge ↔ Organisation, „zuletzt gesehen"-Zeitstempel und letzte Version (Tabellen `bridges`, `organization_bridges`); öffentlicher Schlüssel der Bridge (`bridge_enrollment_keys`). Der private Schlüssel verbleibt ausschließlich auf dem Gerät (Dateirechte 0600).

### 4.3 Steuerkommandos und Statusdaten (Relay)

- Jedes Kommando eines WebApp-Nutzers wird serverseitig signiert und enthält als Metadaten die **Nutzer-UUID, Organisations-UUID, Rolle, Ziel-Bridge, Kommando-Typ und einen Payload-Hash** (Gültigkeit 30 Sekunden). Zweck: Autorisierung und Nachvollziehbarkeit der Fernsteuerung. Rechtsgrundlage: Art. 6 Abs. 1 lit. b, f DSGVO.
- Kommando-Umschläge (einschließlich Payload, z. B. Grafik-Texte, Gerätenamen, Ziel-IP eines Bildmischers) werden zur **Zustellung transient** in der Relay-Datenbank gehalten (`relay_pending_commands`) und nach Zustellung nicht dauerhaft benötigt. **[Konkrete Löschfrist aus dem Relay-Betrieb einsetzen — Retention-Policy.]**
- Statusmeldungen der Bridge an die WebApp können funktionsbedingt enthalten: Gerätenamen (z. B. Kamera-/Ausgabegeräte-Bezeichnungen), die vom Nutzer konfigurierte Ziel-IP/Port eines Bildmischers im LAN, Installationspfade der Software-Komponenten sowie — bei Nutzung des Speichern-Dialogs — den vom Nutzer gewählten Aufnahmepfad. Diese Daten sind nur für autorisierte Nutzer der eigenen Organisation sichtbar.

### 4.4 Inhaltsdaten (auftragsbezogen)

- **Grafik-Vorlagen und dynamische Werte** (z. B. Bauchbinden-Texte mit Namen) werden vom Kunden in der WebApp gepflegt und über das Relay an die Bridge übertragen; Verantwortlichkeit für Inhalte liegt beim Kunden.
- **Meeting-Präsentationen (PDF/PPTX)** werden vom Nutzer in einen privaten Speicher-Bucket hochgeladen (max. 100 MB, Formatprüfung) und von der Bridge über kurzlebige signierte URLs (Gültigkeit 1 Stunde) abgerufen; die Dateien werden serverseitig **automatisch nach 24 Stunden gelöscht** (stündlicher Löschlauf). **Hintergrundbilder/Logos** liegen in einem privaten Bucket (max. 5 MB, nur Bildformate). Abrufe durch die Bridge erfolgen ausschließlich per HTTPS mit technischen Schutzmaßnahmen (u. a. Größen-/Zeitlimits, Blockade privater Netzadressen).

### 4.5 Absturz- und Fehlerdiagnose (Sentry)

Die Desktop-App übermittelt Absturz- und Fehlerberichte an **Sentry** (Functional Software, Inc.), konfiguriert auf **EU-Ingest (Rechenzentrum Deutschland/EU, sentry.io „de"-Region)**. Übermittelt werden technische Fehlerdaten (Fehlermeldung, Stacktrace, App-Version, Betriebssystem-Metadaten, Bildschirmauflösung); es werden **keine Nutzerkonten-Daten gesetzt, keine Screenshots übertragen und kein Rechnername übermittelt** (die Software setzt keinen Servernamen). Der Bridge-Serverprozess und die nativen Helfer enthalten kein Sentry. Zweck: Stabilität und Fehlerbehebung. Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO. **[Optional: Opt-out-Mechanismus dokumentieren, sobald produktseitig vorhanden; derzeit ist die Übermittlung technisch nicht abschaltbar.]**

### 4.6 Update-Prüfung (GitHub)

Die Software prüft Updates gegen die öffentlichen Releases von `github.com/pivotrecruiting/broadify-bridge` (GitHub Inc.). Dabei werden keine Konto- oder Gerätekennungen der Software mitgesendet; es gelten die üblichen technischen Zugriffsdaten des HTTP-Abrufs (IP-Adresse) beim Anbieter GitHub. Download/Installation nur nach Nutzerbestätigung; die Prüfung ist per Umgebungsvariable deaktivierbar.

### 4.7 Lokale Protokolle (auf dem Endgerät)

Bridge- und App-Logs werden lokal gespeichert (App-Datenverzeichnis, `logs/bridge.log` mit 5-MB-Rotation und begrenzter Dateianzahl; Windows-Kamerakomponente: `%ProgramData%\Broadify\vcam.log`). Logs enthalten technische Betriebsdaten und — bedingt durch die Logbibliothek — den lokalen Rechnernamen; sie **verbleiben auf dem Gerät** (kein Kommando und keine Schnittstelle exportiert Logs an broadify) und sind vom Nutzer in der App einsehbar und löschbar. Kommando-Payloads werden in Produktionslogs nicht ausgeschrieben.

### 4.8 Keine Werbe-/Analyse-Tracker

Die Desktop-Software enthält **keine** Analyse-, Tracking- oder Werbe-SDKs (verifiziert; einziges externes Diagnosewerkzeug ist Sentry gemäß 4.5).

## 5. Empfänger und Auftragsverarbeiter

| Empfänger | Leistung | Datenkategorien | Standort/Transfer |
| --- | --- | --- | --- |
| Fly.io, Inc. | Hosting des Relay-Dienstes | Verbindungs-, Kommando- und Statusdaten (4.2, 4.3) | **[Region/SCC dokumentieren]** |
| Supabase, Inc. | Datenbank, Auth, Datei-Speicher der WebApp | Konto-/Organisationsdaten, Geräteregistrierung, Inhalts-Uploads (4.1, 4.2, 4.4) | **[Region/SCC dokumentieren]** |
| Vercel, Inc. | Hosting der WebApp | WebApp-Zugriffsdaten | **[Region/SCC dokumentieren]** |
| Functional Software, Inc. (Sentry) | Absturz-/Fehlerdiagnose | technische Fehlerdaten (4.5) | EU-Ingest; **[SCC/TIA dokumentieren]** |
| GitHub, Inc. (Microsoft) | Bereitstellung signierter Updates | technische Abrufdaten (4.6) | USA; **[SCC dokumentieren]** |
| Stripe | Zahlungsabwicklung | siehe WebApp-/Zahlungs-Datenschutzhinweise | — |

Interne Zugriffe erfolgen nach Need-to-know (Support, Betrieb, Security). **[Vollständige Subprozessorenliste mit Ländern und Transfermechanismen (SCC/TIA) final pflegen.]**

## 6. Speicherdauer

- Pairing-Codes: nur im Arbeitsspeicher, max. 10 Minuten bzw. bis zum Neustart der Software.
- Signierte Abruf-URLs für Inhalte: 1 Stunde.
- Meeting-Präsentationsdateien (Transfer-Bucket): automatische Löschung nach 24 Stunden.
- Kommando-Umschläge im Relay: transient zur Zustellung; **[verbindliche Frist einsetzen]**.
- Relay-Verbindungsprotokolle, Geräteregistrierung: für die Dauer der Organisation-Zuordnung bzw. **[Frist einsetzen]**.
- Sentry-Fehlerdaten: gemäß Sentry-Projektkonfiguration **[Frist einsetzen, Standard 90 Tage]**.
- Lokale Logs: Rolling-Retention auf dem Endgerät (5-MB-Rotation, begrenzte Dateianzahl); Löschung jederzeit durch den Nutzer.
- Lokale Aufzeichnungen, Caches und Konfigurationen: verbleiben bis zur Löschung durch den Nutzer auf dem Endgerät.

## 7. Betroffenenrechte

Betroffene haben, soweit anwendbar, die Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch sowie das Beschwerderecht bei einer Aufsichtsbehörde. Anfragen an: **[EMAIL_PRIVACY]**. Bei Auftragsverarbeitung für einen Kunden werden Anfragen in Abstimmung mit dem Kunden als Verantwortlichem beantwortet; vertragliche Regelungen (AVV) gehen vor.

## 8. Pflicht zur Bereitstellung

Geräte-, Verbindungs- und Sicherheitsmetadaten (4.2, 4.3) sind technisch erforderlich, um Kopplung und Fernsteuerung sicher bereitzustellen; ohne sie sind diese Funktionen nicht nutzbar. Die rein lokalen Funktionen der Software erfordern keine Übermittlung an broadify.

## 9. Änderungen

Diese Hinweise werden angepasst, wenn sich Funktionen, Datenverarbeitungen, Dienstleister oder rechtliche Anforderungen ändern. Es gilt die jeweils veröffentlichte Fassung; wesentliche Änderungen werden versioniert dokumentiert (Dokumentversion, Bezugsstand der Software).

---

*Referenzen: Security- und Remote-Control-Transparenz — broadify Bridge (vollständige Kommando-Liste, Sicherheitsarchitektur) · Technischer Anhang (Verbindungsmechanismen, Systemzugriffe, lokale Speicherung mit Quellcode-Nachweisen) · EULA — broadify Bridge.*
