# Textbausteine fuer Download, Onboarding und Remote-Access-Hinweise

Stand: 25. Februar 2026 (Entwurf)

Hinweis: Diese Texte sind Produkt-/UX-Bausteine und ersetzen keine vollstaendigen Rechtstexte. Sie sollen auf die separaten Dokumente verweisen.

## 1. Download-Modal vor Software-Download (WebApp)

### 1.1 Kurzversion (empfohlen)

**Titel**

`Hinweis zur Desktop-Software und Remote-Steuerung`

**Text**

`Mit dem Download und der Nutzung der Broadify Bridge Desktop-App akzeptieren Sie die Software-Nutzungsbedingungen (EULA) und die Datenschutzhinweise fuer Desktop-App, lokale Bridge und Relay.`

`Die Software installiert eine lokale Bridge-Komponente und kann - je nach Nutzung - ueber die Broadify WebApp remote gesteuert werden. Dabei koennen Steuerungs-, Status- und Inhaltsdaten ueber einen Relay-Dienst verarbeitet werden.`

`Je nach Funktion verarbeitet die Software ausserdem lokale Netzwerk-, System- und Hardwaremetadaten (z. B. Netzwerkinterfaces, Ports, Displays oder angeschlossene Geraete) fuer Konfiguration, Betrieb und Diagnose.`

`Bitte lesen Sie die verlinkten Dokumente vor dem Download sorgfaeltig.`

**Checkbox-Text**

`Ich habe die Software-Nutzungsbedingungen (EULA), die Datenschutzhinweise fuer Desktop-App/Relay sowie die Security- und Remote-Control-Hinweise gelesen und akzeptiere diese.`

**Links (separat)**

- `Software-Nutzungsbedingungen (EULA)`
- `Datenschutzhinweise Desktop-App & Relay`
- `Security- und Remote-Control-Transparenz`
- `Technischer Anhang (Verbindungsmechanismen & Systemzugriffe)` (optional, empfohlen)

### 1.2 Erweiterte Version (falls rechtlich gewuenscht)

`Die Broadify Bridge Desktop-App installiert eine lokal laufende Bridge-Komponente auf Ihrem Geraet. Je nach Konfiguration kann diese lokal, im LAN und ueber die Broadify WebApp via Relay-Dienst zur Fernsteuerung genutzt werden.`

`Remote-Befehle koennen Funktionen auf verbundenen Systemen ausloesen. Stellen Sie sicher, dass nur berechtigte Personen Zugriff auf Ihr Broadify-Konto und Ihre eingesetzten Systeme haben.`

`Mit dem Download/der Nutzung akzeptieren Sie die verlinkten Dokumente.`

## 2. Download-Modal - UI-/Prozesshinweise (nicht nur Text)

Empfohlen:

1. Separate Links fuer EULA und App-Datenschutz (nicht nur Website-AGB/-Datenschutz).
2. Versionierte Dokumente (Stand/Version sichtbar).
3. Checkbox nicht vorangekreuzt.
4. Speicherung von Zeitstempel + Dokumentversion + User-ID (serverseitig) fuer Nachweis.
5. Bei wesentlichen Aenderungen erneute Zustimmung erzwingen.

## 3. App-First-Run-Onboarding (Desktop-App) - Ersatz fuer generischen AGB-Text

Die Desktop-App verweist aktuell auf allgemeine Website-AGB/-Datenschutz. Fuer die installierte Software sollte ein eigener Textbaustein verwendet werden.

### 3.1 Introtext (kompakt)

`Mit der Nutzung der Broadify Bridge Desktop-App stimmen Sie den Software-Nutzungsbedingungen (EULA) sowie den Datenschutzhinweisen fuer Desktop-App, lokale Bridge und Relay zu.`

`Die App startet eine lokal laufende Bridge-Komponente und kann - je nach Konfiguration und Nutzung - ueber die Broadify WebApp remote gesteuert werden. Steuerungs- und Statusdaten sowie in bestimmten Funktionen auch Inhaltsdaten koennen dabei ueber einen Relay-Dienst verarbeitet werden.`

`Je nach Funktion werden ausserdem lokale Netzwerk-, System- und Hardwareinformationen zur Geraeteerkennung, Konfiguration und Diagnose verarbeitet.`

### 3.2 Checkbox-Text (Desktop)

`Ich habe die EULA sowie die Datenschutzhinweise fuer Broadify Bridge (Desktop-App, lokale Bridge, Relay) gelesen und akzeptiere diese.`

### 3.3 Optionaler zusaetzlicher Sicherheitshinweis (empfohlen)

`Ich bin dafuer verantwortlich, den Zugriff auf mein Broadify-Konto, mein Endgeraet und meine verbundenen Systeme angemessen abzusichern (z. B. starke Passwoerter, MFA, Zugriffsbeschraenkungen).`

Hinweis: Ob diese zweite Checkbox rechtlich/UX-seitig sinnvoll ist, sollte abgestimmt werden. Mindestens sollte der Hinweis sichtbar sein.

## 4. In-App-Hinweis bei Aktivierung von Remote-/Relay-Funktion (empfohlen)

### 4.1 Banner/Modal-Text

**Titel**

`Remote-Steuerung aktiv`

**Text**

`Diese Bridge kann jetzt ueber die Broadify WebApp Befehle ueber den Relay-Dienst empfangen. Stellen Sie sicher, dass nur berechtigte Personen Zugriff auf Ihr Konto und Ihre Bridge-Konfiguration haben.`

**Link**

- `Security- und Remote-Control-Hinweise anzeigen`

## 5. Fehler-/Incident-Hinweistext (optional)

`Wenn Sie einen unbefugten Zugriff oder eine missbraeuchliche Fernsteuerung vermuten, deaktivieren Sie die Bridge/Relay-Verbindung und kontaktieren Sie umgehend den Broadify-Support unter [SECURITY_CONTACT_EMAIL].`

## 6. Platzhalter fuer Links (final befuellen)

- EULA: `[URL_EULA_DESKTOP]`
- Datenschutz App/Relay: `[URL_PRIVACY_DESKTOP_RELAY]`
- Security-Transparenz: `[URL_SECURITY_REMOTE]`

## 7. Mapping auf aktuellen Produktstand (wichtig)

Der aktuelle Desktop-Onboarding-Dialog verweist auf `broadify.de/agb` und `broadify.de/datenschutzerklaerung`. Diese Verweise sollten fuer Desktop-spezifische Zustimmung auf die neuen Dokumente umgestellt werden (oder auf eine zentrale Datenschutzerklaerung mit klar getrennten Abschnitten fuer Website/WebApp vs. Desktop-App/Relay).

Ergaenzend kann ein technischer Anhang verlinkt werden, wenn ihr bei Enterprise-/Broadcast-Kunden die Verbindungsmechanismen und Systemzugriffe transparent ausweisen wollt.
