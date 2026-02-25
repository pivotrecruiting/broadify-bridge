# Software-Nutzungsbedingungen (EULA) - Broadify Bridge Desktop App

Stand: 25. Februar 2026 (Entwurf)

Hinweis: Mustertext / keine Rechtsberatung. B2B-/B2C-spezifische Klauseln muessen juristisch finalisiert werden.

## 1. Vertragspartner und Geltungsbereich

Diese Software-Nutzungsbedingungen gelten fuer die installierbare Desktop-Software "Broadify Bridge" einschliesslich lokaler Bridge-Komponente, optionaler Relay-Anbindung und zugehoeriger Update-/Supportleistungen (zusammen "Software").

Anbieter / Lizenzgeber:

- `[LEGAL_ENTITY_NAME]`
- `[ADDRESS]`
- `[EMAIL_LEGAL]`

Diese Bedingungen ergaenzen die Bedingungen fuer Website/WebApp/Abrechnung. Im Konfliktfall gehen fuer die installierte Software diese Software-Nutzungsbedingungen vor.

## 2. Leistungsbeschreibung (Kurzbeschreibung)

Die Software dient der lokalen Anbindung, Steuerung und Uebermittlung von Steuerungs-/Statusdaten zwischen:

- der installierten Broadify Bridge auf dem Endgeraet des Nutzers,
- lokalen Zielsystemen/Geraeten im Netzwerk (z. B. Broadcast-/Engine-Systeme),
- der Broadify-WebApp und einem Relay-Dienst fuer Remote-Steuerung.

Die Software kann Befehle empfangen, die ueber die Broadify-WebApp und den Relay-Dienst an die lokale Bridge uebermittelt werden.

## 3. Lizenzumfang

Der Lizenzgeber raeumt dem Nutzer eine einfache, nicht ausschliessliche, nicht uebertragbare und widerrufliche Lizenz ein, die Software waehrend der Vertragslaufzeit nach Massgabe dieser Bedingungen zu nutzen.

Zulaessig ist insbesondere:

- Installation auf den vertraglich zulaessigen Endgeraeten,
- Nutzung fuer eigene betriebliche Zwecke (oder gemaess gebuchtem Plan),
- Konfiguration der lokalen Bridge und verbundenen Systeme.

Nicht zulaessig ist insbesondere, soweit gesetzlich zulaessig:

- Unterlizenzierung, Weiterverkauf oder Vermietung der Software,
- Umgehung technischer Schutzmechanismen,
- Reverse Engineering, Dekompilierung oder Disassemblierung (ausser gesetzlich zwingend erlaubt),
- Nutzung zur unbefugten Fernsteuerung fremder Systeme,
- Nutzung in rechtswidrigen, sicherheitskritischen oder missbraeuchlichen Szenarien.

## 4. Voraussetzungen und Systemzugriffe

Dem Nutzer ist bekannt und er stimmt zu, dass die Software fuer ihre Funktion technisch erforderliche Zugriffe und Prozesse nutzt, insbesondere:

- lokale Installation auf dem Endgeraet,
- lokale Hintergrundprozesse / lokaler Bridge-Dienst,
- lokale Hilfsprozesse / native Komponenten fuer Rendering, Geraeteerkennung und Ausgabe (je nach Plattform/Funktion),
- Netzwerkkommunikation (lokal, LAN optional, Internet fuer Relay/Cloud-Dienste),
- mehrere Verbindungsmechanismen (z. B. lokales HTTP/WebSocket, Remote-Relay-WebSocket, lokales TCP-IPC zwischen internen Komponenten),
- Kommunikation mit der Broadify-WebApp und Relay-Infrastruktur,
- Zugriff auf lokale System-/Netzwerkinformationen zur Konfiguration und Geraeteerkennung (z. B. Netzwerkinterfaces, IP-Adressen, Port-Verfuegbarkeit),
- Zugriff auf Hardware-/Geraetemetadata (z. B. Displays, USB-/Capture-Geraete, DeckLink-Geraete/-Modi; plattformabhaengig),
- Zugriff auf Systemressourcen-/Diagnosedaten (z. B. CPU/RAM/Datentraegerkennwerte) fuer Anzeige/Diagnose,
- Zugriff auf angeschlossene bzw. im Netzwerk erreichbare Zielsysteme gemaess Nutzerkonfiguration,
- lokale Protokollierung (Logs) zu Betriebs-, Fehler- und Sicherheitszwecken.

Soweit die Software Funktionen zur Geraete-/Output-Erkennung, Netzwerkbindung oder Remote-Steuerung anbietet, sind diese Bestandteil der vereinbarten Funktionalitaet.

Hinweis: Nach aktuellem Stand werden systemnahe Informationen ausgelesen, jedoch keine allgemeinen Betriebssystemeinstellungen ueber eine dedizierte System-Preferences-API geaendert. Technische und plattformabhaengige Details koennen im technischen Anhang beschrieben werden.

## 5. Remote-Steuerung / Fernzugriff (wesentliche Klausel)

1. Die Software ist darauf ausgelegt, dass bestimmte Befehle ueber die Broadify-WebApp und einen Relay-Dienst an die lokal installierte Bridge uebermittelt werden koennen ("Remote-Steuerung").
2. Mit Aktivierung/Nutzung der Software autorisiert der Nutzer diese Fernuebermittlung im Rahmen der produktseitig vorgesehenen Funktionen.
3. Der Nutzer ist verantwortlich fuer die Absicherung seiner Zugaenge und Endgeraete, insbesondere:
   - sichere Passwoerter,
   - Mehrfaktor-Authentisierung (falls angeboten),
   - Zugriffsbeschraenkungen innerhalb seines Unternehmens,
   - Schutz vor unbefugtem Zugriff auf Nutzerkonten und Endgeraete.
4. Der Nutzer darf Remote-Funktionen nur fuer Systeme verwenden, fuer die er berechtigt ist.
5. Der Nutzer ist verpflichtet, Missbrauch, Verdacht auf Kompromittierung oder unbefugte Nutzung unverzueglich zu melden an: `[SECURITY_CONTACT_EMAIL]`.

## 6. Pflichten des Nutzers (Betrieb und Sicherheit)

Der Nutzer ist insbesondere verpflichtet:

- die Software nur in kompatiblen und ausreichend gesicherten Umgebungen einzusetzen,
- Zugangsdaten vertraulich zu behandeln,
- lokale Netzwerke, Endgeraete und angeschlossene Systeme angemessen abzusichern,
- Updates/Sicherheitshinweise des Anbieters zu beachten,
- keine unzulaessigen oder gefaehrlichen Kommandos/Workflows einzurichten,
- erforderliche Einwilligungen/Freigaben fuer Inhalte und personenbezogene Daten einzuholen, die ueber die Software verarbeitet werden.

## 7. Datenverarbeitung und Datenschutz

Informationen zur Verarbeitung personenbezogener Daten in Zusammenhang mit der Software, der lokalen Bridge und dem Relay-Dienst ergeben sich aus der gesonderten Datenschutzerklaerung fuer Desktop-App und Relay.

Sofern der Anbieter personenbezogene Daten im Auftrag des Kunden verarbeitet, kann ein Auftragsverarbeitungsvertrag (AVV/DPA) erforderlich sein.

## 8. Updates, Aenderungen, Wartung

Der Anbieter kann die Software im Rahmen der vertraglichen Vereinbarungen aktualisieren, weiterentwickeln oder Sicherheitsupdates bereitstellen.

Der Nutzer nimmt zur Kenntnis, dass:

- Funktionen geaendert, erweitert oder eingestellt werden koennen, soweit vertraglich und rechtlich zulaessig,
- Sicherheitsmassnahmen angepasst werden koennen,
- fuer einen sicheren Betrieb eine aktuelle Version erforderlich sein kann.

## 9. Verfuegbarkeit und Leistungsgrenzen

Die Funktion der Software kann von Drittkomponenten und externen Faktoren abhaengen, insbesondere:

- Internetverbindung,
- lokale Netzwerkkonfiguration,
- angeschlossene Drittgeraete/-systeme,
- Betriebszustand des Relay-Dienstes,
- Plattformdienste und Betriebssystemumgebung.

Eine unterbrechungsfreie oder fehlerfreie Verfuegbarkeit wird nur geschuldet, soweit dies ausdruecklich vertraglich vereinbart ist.

## 10. Haftung / Haftungsbeschraenkung (juristisch finalisieren)

### 10.1 Allgemein

Der Anbieter haftet nach den gesetzlichen Vorschriften bei Vorsatz und grober Fahrlaessigkeit sowie bei Verletzung von Leben, Koerper oder Gesundheit.

### 10.2 Typische Beschraenkungen (insb. B2B)

Im Uebrigen ist die Haftung - soweit gesetzlich zulaessig - beschraenkt auf vorhersehbare, vertragstypische Schaeden.

Ausgeschlossen oder beschraenkt werden sollten (juristisch pruefen):

- indirekte Schaeden und Folgeschaeden,
- entgangener Gewinn,
- Produktions-/Sendungsausfaelle durch Fehlbedienung oder Fehlkonfiguration,
- Schaeden durch kompromittierte Nutzerkonten oder unzureichende Zugangssicherung auf Nutzerseite,
- Schaeden durch Drittgeraete/Drittsysteme oder deren Fehlverhalten.

### 10.3 Remote-Steuerungsspezifische Risikoverteilung

Der Nutzer ist fuer die fachgerechte Konfiguration und Freigabe der ueber die Software fernsteuerbaren Funktionen verantwortlich. Der Anbieter haftet nicht fuer Schaeden, die aus unbefugter Nutzung auf Nutzerseite resultieren, sofern der Anbieter die vertraglich geschuldeten Sicherheitsmassnahmen eingehalten hat und kein eigenes Verschulden vorliegt.

Wichtig: Fuer B2C gelten engere gesetzliche Grenzen. B2C-Klauseln separat juristisch formulieren.

## 11. Sperrung / Suspendierung

Der Anbieter kann den Zugriff auf Remote-Dienste oder die Nutzung der Software ganz oder teilweise sperren, wenn:

- ein Sicherheitsvorfall oder Missbrauch vermutet wird,
- erhebliche Vertragsverstoesse vorliegen,
- die Sperrung zur Gefahrenabwehr oder zur Einhaltung gesetzlicher Pflichten erforderlich ist.

Soweit moeglich, erfolgt eine Information des Nutzers vorab oder unverzueglich nachtraeglich.

## 12. Laufzeit, Beendigung, Folgen der Beendigung

Die Laufzeit richtet sich nach dem zugrunde liegenden Subscription-/Vertragspaket. Mit Vertragsende endet regelmaessig das Nutzungsrecht an der Software bzw. an Remote-/Cloud-Funktionen, soweit nichts anderes vereinbart ist.

Nach Vertragsende koennen Remote-Funktionen deaktiviert sein; lokal gespeicherte Daten auf dem Geraet des Nutzers verbleiben zunaechst auf dem Geraet, soweit keine automatische Loeschroutine greift.

## 13. Export, Sanktionen, Compliance (optional je Zielmarkt)

Der Nutzer sichert zu, die Software nicht unter Verstoss gegen anwendbare Exportkontroll-, Sanktions- oder Embargovorschriften zu verwenden.

## 14. Rangfolge der Dokumente

Empfohlene Rangfolge (bei Widerspruechen):

1. Individualvertrag / Angebot / Auftragsformular
2. Leistungsbeschreibung / SLA (falls vorhanden)
3. Diese Software-Nutzungsbedingungen (EULA)
4. Website-/WebApp-AGB
5. Sonstige Richtlinien

## 15. Gerichtsstand / anwendbares Recht (juristisch finalisieren)

Platzhalter fuer Rechtswahl und Gerichtsstand:

- Anwendbares Recht: `[JURISDICTION_LAW]`
- Gerichtsstand (B2B): `[COURT]`

Fuer Verbraucher (B2C) gelten zwingende Verbraucherschutzvorschriften.

## Anhang A - Produktspezifische Hinweise (technischer Bezug)

Dieser Anhang dient der Transparenz und kann in Kurzform in die Produktdokumentation uebernommen werden:

- Die Desktop-App startet eine lokale Bridge-Komponente.
- Die Bridge kann lokal oder optional im LAN erreichbar sein (je nach Konfiguration).
- Remote-Steuerung erfolgt ueber WebApp + Relay-Dienst.
- Die Software verarbeitet Steuerungs-, Status- und Konfigurationsdaten.
- Fehler- und Betriebslogs koennen lokal gespeichert werden.
- Fehlertracking-/Crashdiagnose kann ueber externe Dienste erfolgen (siehe Datenschutzerklaerung).
- Die Software kann lokale Hardware-/Systemmetadaten zur Geraeteerkennung und Konfiguration auslesen (plattformabhaengig).
- Fuer Graphics/Outputs koennen lokale Hilfsprozesse und native Komponenten verwendet werden.
- Details zu Verbindungsmechanismen, Systemabfragen und lokaler Speicherung siehe technischer Anhang.
