# Software-Nutzungsbedingungen (EULA) — broadify Bridge

Stand: 24. August 2026 · Dokumentversion 2.0 · Bezugsstand der Software: broadify Bridge v0.25.2

> Verbindlichkeitshinweis: Alle technischen Aussagen dieses Dokuments sind aus dem Quellcode der Version v0.25.2 abgeleitet und verifiziert. Mit `[…]` markierte Angaben (Rechtsträger, Rechtswahl, Gerichtsstand, SLA) sind vor Veröffentlichung durch Geschäftsführung bzw. Rechtsprüfung festzulegen. Englische Fassung: `docs/legal/en/eula-broadify-bridge.md` (informatorisch).

## 1. Vertragspartner und Geltungsbereich

1.1 Diese Software-Nutzungsbedingungen („EULA") gelten für die installierbare Desktop-Software **broadify Bridge** einschließlich der lokalen Bridge-Komponente, der nativen Hilfskomponenten (u. a. virtuelle Kamera, Meeting-/Grafik-/Display-Helfer) und der Relay-Anbindung zur Fernsteuerung (zusammen „Software").

Anbieter/Lizenzgeber: **[LEGAL_ENTITY_NAME] · [ADDRESS] · [EMAIL_LEGAL]**

1.2 Diese EULA ergänzt die Bedingungen für Website/WebApp/Abrechnung. Im Konflikt geht für die installierte Software diese EULA vor (Rangfolge in Abschnitt 14).

## 2. Leistungsbeschreibung und Produktlinien

2.1 Die Software ist die lokale Geräte-Komponente der broadify-Produktlinien. Der jeweils nutzbare Funktionsumfang richtet sich nach dem gebuchten Plan; die Zuordnung erfolgt in der broadify-WebApp:

- **broadifyStudio** — Ansteuerung von Produktionshardware und Grafikausgabe: Bildmischer (Blackmagic ATEM über LAN und USB, vMix, NewTek TriCaster), Grafik-Rendering mit Ausgabe über Blackmagic-DeckLink-Hardware oder angeschlossene Displays, Elgato Stream Deck, Kamera-Presets (Canon XC), schaltbare Steckdosen (Shelly/Tasmota).
- **broadifyMeeting** — lokale Kamera-Verarbeitung für Videokonferenzen: Personen-Freistellung (Keying) vollständig auf dem Endgerät, Hintergrund- und Inhaltseinblendung, Bereitstellung des Ergebnisses als virtuelle Systemkamera („Broadify Camera") für Konferenzsoftware (z. B. Microsoft Teams, Zoom), lokale MP4-Aufzeichnung.
- **broadifyConference** — Konferenzraum-Funktionen: Display-Ausgabe sowie automatische Bildregie auf Basis von Mikrofon-Array-Daten (unterstützt: Shure, Sennheiser TCC2).

2.2 Die Software empfängt Steuerkommandos, die autorisierte Nutzer der Kundenorganisation über die broadify-WebApp und den Relay-Dienst an die lokal installierte Bridge übermitteln (Abschnitt 5).

## 3. Lizenzumfang

3.1 Der Lizenzgeber räumt dem Nutzer eine einfache, nicht ausschließliche, nicht übertragbare, widerrufliche Lizenz ein, die Software während der Vertragslaufzeit nach Maßgabe dieser Bedingungen zu nutzen. Die Anzahl zulässiger Installationen („Bridges") richtet sich nach dem gebuchten Plan.

3.2 Zulässig sind insbesondere Installation auf vertraglich zulässigen Endgeräten, Nutzung für eigene betriebliche Zwecke gemäß Plan sowie Konfiguration der Bridge und verbundener Systeme.

3.3 Nicht zulässig sind, soweit gesetzlich nicht zwingend erlaubt: Unterlizenzierung, Weiterverkauf oder Vermietung; Umgehung technischer Schutzmechanismen; Reverse Engineering, Dekompilierung oder Disassemblierung außerhalb der §§ 69d, 69e UrhG; Nutzung zur unbefugten Fernsteuerung fremder Systeme; Nutzung in rechtswidrigen oder missbräuchlichen Szenarien. Rechte aus Open-Source-Lizenzen mitgelieferter Drittkomponenten (Abschnitt 8) bleiben unberührt.

## 4. Installation, Systemzugriffe und Systemintegration

4.1 Dem Nutzer ist bekannt, dass die Software für ihre Funktion die folgenden — abschließend im „Technischen Anhang" und im Transparenzdokument beschriebenen — Zugriffe nutzt:

- lokale Installation; unter **Windows** maschinenweit („per machine", `C:\Program Files`) mit Administratorrechten; der Installer registriert die virtuelle Kamera (COM-Komponente `broadify-vcam.dll`) im Windows-Kamera-Subsystem und entfernt die Registrierung bei Deinstallation;
- unter **macOS** eine sandboxed CoreMediaIO-Systemerweiterung für die virtuelle Kamera (`com.broadify.vcam.extension`), deren Aktivierung eine ausdrückliche Nutzerfreigabe in den Systemeinstellungen erfordert; Kamera- und Mikrofonzugriff über die macOS-Berechtigungsdialoge;
- lokale Hintergrund- und Hilfsprozesse (Bridge-Server, Meeting-/Grafik-/Display-Helfer), die ausschließlich an den Lebenszyklus der Desktop-App gebunden sind;
- Netzwerkkommunikation: lokal (Loopback), optional LAN gemäß Nutzerkonfiguration, Internet ausschließlich für Relay, Update-Prüfung, Absturzdiagnose und den Abruf vom Kunden bereitgestellter Inhalte (Details: Datenschutzhinweise);
- Zugriff auf Hardware-/Gerätemetadaten (Displays, Capture-/DeckLink-Geräte, Kameras, Mikrofone) zur Geräteerkennung;
- lokale Protokollierung (Logs) zu Betriebs-, Fehler- und Sicherheitszwecken.

4.2 Die Software richtet **keinen Autostart, keinen Windows-Dienst und keinen macOS-LaunchAgent/-Daemon** ein. Sämtliche Prozesse der Software laufen nur, solange der Nutzer die App gestartet hat, und beenden sich mit ihr; ein Überwachungsmechanismus beendet verwaiste Hilfsprozesse selbsttätig.

## 5. Remote-Steuerung / Fernzugriff (wesentliche Klausel)

5.1 Fernsteuerung setzt eine aktive Kopplung durch den Kunden voraus (Pairing-Verfahren mit 8-stelligem Zufallscode, Gültigkeit 10 Minuten, Neuerzeugung bei jedem Start der Software). Ohne Kopplung und ohne laufende Software ist keine Fernsteuerung möglich.

5.2 Der Umfang der Fernsteuerung ist technisch auf eine feste, versionierte Kommando-Liste begrenzt; jedes Kommando ist kryptografisch signiert (Ed25519), zeitlich befristet und replay-geschützt und wird vor Ausführung schema-validiert. Es existiert **kein** Kommando zur Ausführung beliebigen Codes, zum Auslesen beliebiger Dateien oder zur Bildschirmaufnahme. Die vollständige Kommando-Liste, die Sicherheitsarchitektur und die bekannten Grenzen sind im Dokument „Security- und Remote-Control-Transparenz — broadify Bridge" offengelegt.

5.3 Video- und Audiodaten verlassen das Endgerät nicht über broadify-Infrastruktur; Keying, Kompositing, virtuelle Kamera und Aufzeichnung laufen vollständig lokal (vgl. Datenschutzhinweise, Abschnitt „Lokale Verarbeitung").

5.4 Der Nutzer ist verantwortlich für die Absicherung seiner Zugänge und Endgeräte (sichere Passwörter, Mehrfaktor-Authentisierung soweit angeboten, Rollen-/Rechtevergabe in seiner Organisation) und dafür, Remote-Funktionen nur für Systeme zu verwenden, für die er berechtigt ist. Missbrauch oder Verdacht auf Kompromittierung ist unverzüglich zu melden an: **[SECURITY_CONTACT_EMAIL]**.

## 6. Pflichten des Nutzers (Betrieb und Sicherheit)

Der Nutzer ist insbesondere verpflichtet: die Software nur in kompatiblen, angemessen gesicherten Umgebungen einzusetzen; Zugangsdaten und Pairing-Codes vertraulich zu behandeln; lokale Netzwerke, Endgeräte und angeschlossene Systeme abzusichern; Updates und Sicherheitshinweise zu beachten; erforderliche Einwilligungen für Inhalte und personenbezogene Daten einzuholen, die über die Software verarbeitet werden. Auf Mehrbenutzersystemen mit nicht vertrauenswürdigen lokalen Nutzern ist der Einsatz mit dem IT-Sicherheitsverantwortlichen abzustimmen (lokales Vertrauensmodell, siehe Transparenzdokument).

## 7. Updates, Änderungen, Wartung

7.1 Die Software prüft nach dem Start und danach alle sechs Stunden auf Updates. Bezugsquelle sind ausschließlich signierte Releases des Repositories `github.com/pivotrecruiting/broadify-bridge`. Download und Installation erfolgen **erst nach Bestätigung durch den Nutzer** (kein automatischer Download, keine automatische Installation beim Beenden). Die Update-Prüfung kann über die Umgebungsvariable `BROADIFY_DISABLE_AUTO_UPDATE` deaktiviert werden.

7.2 Windows-Builds sind per Azure Trusted Signing (Authenticode, RFC-3161-Zeitstempel) signiert; macOS-Builds sind Developer-ID-signiert, gehärtet (Hardened Runtime) und von Apple notarisiert. Update-Metadaten enthalten SHA-512-Prüfsummen, die der Updater vor Installation verifiziert.

7.3 Der Anbieter kann Funktionen im vertraglich und rechtlich zulässigen Rahmen ändern, erweitern oder einstellen und Sicherheitsmaßnahmen anpassen. Für einen sicheren Betrieb kann eine aktuelle Version erforderlich sein.

## 8. Drittkomponenten und Open-Source-Software

8.1 Die Software enthält bzw. nutzt Drittkomponenten, insbesondere: Electron/Chromium (MIT), React (MIT), ONNX Runtime (MIT), Microsoft DirectML (proprietäre Redistributable-Bedingungen, nur Windows), Intel OpenVINO Runtime (Apache-2.0, nur Windows), MODNet-Segmentierungsmodell (Apache-2.0), pdf.js (Apache-2.0), stb_image (Public Domain/MIT), SDL2 (zlib, nur macOS), LibreOffice als Präsentations-Renderer (MPL-2.0, nur macOS/arm64), Anbindungen an Blackmagic-Hardware (kompiliert gemäß den Bedingungen des Blackmagic-SDK) sowie weitere Bibliotheken unter permissiven Lizenzen. Die vollständige Liste einschließlich Lizenztexten führt die Datei `NOTICES.md` der Software.

8.2 Für Open-Source-Komponenten gelten vorrangig deren Lizenzbedingungen; diese EULA schränkt daraus resultierende Nutzerrechte nicht ein. Die Software enthält kein NDI-SDK. Betriebssystem-Frameworks (Media Foundation, AVFoundation, CoreML, Vision) werden genutzt, aber nicht mitvertrieben.

## 9. Datenverarbeitung und Datenschutz

Die Verarbeitung personenbezogener Daten ist in den „Datenschutzhinweisen — broadify Bridge" beschrieben. Sofern der Anbieter personenbezogene Daten im Auftrag des Kunden verarbeitet, wird auf Anforderung ein Auftragsverarbeitungsvertrag (AVV/DPA) geschlossen: **[AVV-Referenz/Prozess einsetzen]**.

## 10. Verfügbarkeit und Leistungsgrenzen

Der Relay-Dienst ist ein Cloud-Dienst; Verfügbarkeitszusagen ergeben sich ausschließlich aus dem Hauptvertrag bzw. SLA **[Referenz einsetzen]**. Die lokalen Funktionen der Software (Keying, virtuelle Kamera, Aufzeichnung, Hardware-Ansteuerung im LAN) funktionieren unabhängig von der Relay-Verfügbarkeit, sofern keine Fernsteuerung benötigt wird. Im Übrigen kann die Funktion von Drittgeräten, Netzwerkkonfiguration und Plattformdiensten abhängen; eine unterbrechungsfreie Verfügbarkeit wird nur geschuldet, soweit ausdrücklich vereinbart.

## 11. Haftung (juristisch zu finalisieren)

11.1 Der Anbieter haftet nach den gesetzlichen Vorschriften bei Vorsatz und grober Fahrlässigkeit sowie bei Verletzung von Leben, Körper oder Gesundheit und nach dem Produkthaftungsgesetz.

11.2 Im Übrigen ist die Haftung — soweit gesetzlich zulässig — auf die Verletzung wesentlicher Vertragspflichten und den vertragstypisch vorhersehbaren Schaden beschränkt. **[B2B-/B2C-Differenzierung, Haftungshöchstbeträge und Ausschlüsse (Folgeschäden, entgangener Gewinn, Produktions-/Sendungsausfälle durch Fehlbedienung, kompromittierte Nutzerkonten, Drittgeräte) juristisch formulieren.]**

11.3 Der Nutzer ist für die fachgerechte Konfiguration und Freigabe fernsteuerbarer Funktionen verantwortlich. Der Anbieter haftet nicht für Schäden aus unbefugter Nutzung auf Nutzerseite, sofern er die vertraglich geschuldeten Sicherheitsmaßnahmen eingehalten hat und kein eigenes Verschulden vorliegt.

## 12. Sperrung / Suspendierung

Der Anbieter kann den Zugriff auf Remote-Dienste ganz oder teilweise sperren, wenn ein Sicherheitsvorfall oder Missbrauch vermutet wird, erhebliche Vertragsverstöße vorliegen oder die Sperrung zur Gefahrenabwehr bzw. Einhaltung gesetzlicher Pflichten erforderlich ist. Soweit möglich, wird der Nutzer vorab, andernfalls unverzüglich nachträglich informiert. Die lokalen Funktionen der installierten Software bleiben von einer Relay-Sperrung technisch unberührt.

## 13. Laufzeit, Beendigung, Folgen der Beendigung

Die Laufzeit richtet sich nach dem zugrunde liegenden Vertrag. Mit Vertragsende endet das Nutzungsrecht; der Kunde deinstalliert die Software und kann die Kopplung seiner Bridges in der WebApp entfernen. Lokal gespeicherte Daten (Aufzeichnungen, Logs, Caches) verbleiben auf dem Gerät des Nutzers und liegen in seiner Verantwortung.

## 14. Rangfolge der Dokumente

Bei Widersprüchen gilt: 1. Individualvertrag/Angebot/Auftragsformular · 2. Leistungsbeschreibung/SLA · 3. diese EULA · 4. Website-/WebApp-AGB · 5. sonstige Richtlinien. Die Transparenzdokumente (Datenschutzhinweise, Security- und Remote-Control-Transparenz, Technischer Anhang) sind Informationsunterlagen und begründen keine über den Vertrag hinausgehenden Leistungspflichten.

## 15. Export und Compliance

Der Nutzer sichert zu, die Software nicht unter Verstoß gegen anwendbare Exportkontroll-, Sanktions- oder Embargovorschriften zu verwenden.

## 16. Anwendbares Recht, Gerichtsstand (juristisch zu finalisieren)

Anwendbares Recht: **[JURISDICTION_LAW, z. B. Recht der Bundesrepublik Deutschland unter Ausschluss des UN-Kaufrechts]**. Gerichtsstand (B2B): **[COURT]**. Für Verbraucher gelten zwingende Verbraucherschutzvorschriften. Maßgebliche Vertragssprache ist Deutsch.

---

*Referenzen: Datenschutzhinweise — broadify Bridge · Security- und Remote-Control-Transparenz — broadify Bridge · Technischer Anhang (Verbindungsmechanismen, Systemzugriffe, lokale Speicherung) · NOTICES.md.*
