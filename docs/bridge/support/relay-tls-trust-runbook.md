# Support-Runbook: Relay-Verbindung hinter TLS-Inspection (Firmennetz)

Für Support und Kunden-IT. Gilt ab der Bridge-Version, die den Spawn-Vertrag
mit `NODE_USE_SYSTEM_CA=1` enthält (siehe „Was die Bridge tut"). Hintergrund
zum Relay-Transport: `docs/bridge/features/relay-protocol.md`.

## Symptom

- Pairing in der Webapp schlägt fehl, die Bridge erscheint nie „online".
- Lokal ist alles gesund (Server auf `127.0.0.1:8787`, Renderer, Helper).
- Im Bridge-Log wiederholt sich im Backoff (1 s bis 60 s):

```text
[Relay] Connecting to relay at wss://broadify-relay.fly.dev...
[Relay] WebSocket error: self signed certificate in certificate chain (code: SELF_SIGNED_CERT_IN_CHAIN) - relay TLS certificate chain is not trusted by this process, typically because a TLS-inspecting proxy or firewall re-signs the connection with a private root CA. System trust store: enabled. Fix: install the issuing root CA in the OS trust store, point NODE_EXTRA_CA_CERTS at its PEM file, or exempt the relay host from TLS inspection.
[Relay] Disconnected from relay server (code: 1006, reason: n/a)
```

Ältere Versionen loggen nur `WebSocket error: self signed certificate in
certificate chain` ohne Code und Hinweis. Der Close-Code 1006 ist Folge, nicht
Ursache.

## Ursache

Eine Firewall oder ein Proxy im Kundennetz (Zscaler, Palo Alto, Fortinet,
Netskope u. ä.) bricht TLS auf und signiert die Verbindung zum Relay mit einer
firmeneigenen Root-CA neu. Diese Root-CA verteilt die IT per Richtlinie in den
Windows- bzw. macOS-Zertifikatspeicher. Browser und der Electron-Updater nutzen
diesen Speicher und funktionieren. Die Bridge läuft als Node.js-Prozess, und
Node.js vertraut standardmäßig nur seiner eingebauten Mozilla-CA-Liste. Die
Firmen-CA ist dort unbekannt, die Prüfung schlägt fehl.

Der Fehler tritt beim TLS-Handshake auf (typisch 30 bis 40 ms nach dem
Verbindungsversuch). DNS und TCP funktionieren also, sonst käme `ENOTFOUND`,
`ECONNREFUSED` oder `ETIMEDOUT`.

## Was die Bridge tut

- Der Desktop-Prozess startet die Bridge mit `NODE_USE_SYSTEM_CA=1`
  (`src/electron/services/bridge-process-contract.ts`). Node.js lädt damit
  zusätzlich zur eingebauten Liste die vertrauenswürdigen Root-CAs des
  Betriebssystems (Windows: Trusted Root Certification Authorities für Local
  Machine und Current User inklusive Enterprise- und Group-Policy-Stores;
  macOS: System- und Default-Keychain mit „Always Trust"). Ein bereits gesetzter
  Wert aus der Umgebung des Desktop-Prozesses wird nicht überschrieben.
- `NODE_EXTRA_CA_CERTS` aus der Umgebung wird unverändert durchgereicht.
- Beim Start loggt die Bridge den Zustand des Trust Stores:

```text
[RuntimeDiagnostics] TLS trust store {"systemCaEnabled":true,"systemCaSource":"env","extraCaCertsConfigured":false,"caCertificateCounts":{"default":156,"bundled":144,"system":12,"extra":0}}
```

  `systemCaSource` ist `env`, `flag`, `node_options` oder `off`. `default` ist
  die effektiv genutzte Liste, `system` die Anzahl aus dem OS-Speicher, `extra`
  die Anzahl aus `NODE_EXTRA_CA_CERTS`. Auf Runtimes ohne diese API steht dort
  `"caCertificateCounts":null`.
- Relay-Socket-Fehler werden mit Node-Fehlercode geloggt. Für nicht vertraute
  Ketten und ungültige Zertifikate steht ein Handlungshinweis dahinter
  (`apps/bridge/src/services/relay-socket-error.ts`).

Die Verschlüsselung bleibt vollständig aktiv. Es wird ausschließlich die Liste
der vertrauten Aussteller um die des Betriebssystems erweitert, und zwar
prozessweit für alle TLS-Clients der Bridge (Relay, JWKS-Abruf, HTTPS zu
Geräten), genau wie bei Browser und Electron-Updater. Die
Bridge-Identität ist zusätzlich per Ed25519 signiert; ein Proxy kann mitlesen,
aber keine Bridge fälschen.

## Diagnose

1. Bridge-Log auf `[RuntimeDiagnostics] TLS trust store` prüfen.
   `systemCaEnabled:false` bedeutet: alte Version oder IT hat
   `NODE_USE_SYSTEM_CA` explizit auf einen anderen Wert gesetzt.
2. `[Relay] WebSocket error` mit `code:` lesen:
   - `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
     `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `DEPTH_ZERO_SELF_SIGNED_CERT`:
     Kette nicht vertraut, dieses Runbook.
   - `CERT_HAS_EXPIRED`, `CERT_NOT_YET_VALID`, `ERR_TLS_CERT_ALTNAME_INVALID`:
     Systemuhr oder fehlerhafte Proxy-Konfiguration.
   - `ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`: Netz, DNS oder Firewall-Block,
     nicht TLS.
3. Beim Kunden im Browser `https://broadify-relay.fly.dev` öffnen und den
   Aussteller im Schloss-Symbol ansehen. Steht dort nicht „Let's Encrypt",
   sondern der Firmen- oder Firewall-Hersteller, ist TLS-Inspection bestätigt.
4. Alternativ in PowerShell: `certutil -store Root` und nach der Firmen- oder
   Proxy-CA suchen.

## Lösungen in Rangfolge

1. **Aktuelle Bridge-Version installieren.** Liegt die Firmen-Root-CA im
   Windows-Speicher „Trusted Root Certification Authorities" (Local Machine
   oder Current User), verbindet sich die Bridge ohne weitere Konfiguration.
2. **Ausnahme durch die Kunden-IT.** `broadify-relay.fly.dev` auf die
   SSL-Inspection-Bypass-Liste setzen. Dann sieht die Bridge das echte
   Let's-Encrypt-Zertifikat.
3. **CA-Datei explizit angeben.** Wenn die Root-CA nicht im OS-Speicher liegt
   (oder nur im Zwischenzertifikat-Speicher): Root-CA als PEM exportieren und
   systemweit `NODE_EXTRA_CA_CERTS=C:\ProgramData\Broadify\corp-root.pem`
   setzen. Die Variable erreicht die Bridge über die Umgebung des
   Desktop-Prozesses. Bridge danach komplett neu starten.
4. **Opt-out durch die IT.** `NODE_USE_SYSTEM_CA=0` systemweit setzen, falls
   der OS-Speicher bewusst nicht genutzt werden soll. Nur der Wert `1`
   aktiviert den Speicher, jeder andere Wert deaktiviert ihn.

Niemals `NODE_TLS_REJECT_UNAUTHORIZED=0` empfehlen. Das schaltet die
Zertifikatsprüfung vollständig ab.

## IT-Freigabetext (Vorlage)

> Broadify Bridge verbindet sich ausgehend per WebSocket über TLS (Port 443)
> mit `broadify-relay.fly.dev`. Die Anwendung unterstützt SSL-Inspection,
> sofern die signierende Root-CA im Windows-Zertifikatspeicher „Trusted Root
> Certification Authorities" (Local Machine oder Current User) liegt.
> Alternativ bitte `broadify-relay.fly.dev` von der Inspection ausnehmen.
> Es sind keine eingehenden Verbindungen und keine weiteren Ports nötig.

## Grenzen und offene Punkte

- Ein expliziter Proxy (PAC, WinHTTP, Proxy-Authentifizierung) wird vom
  Relay-Client noch nicht unterstützt. Bei transparenter Inspection ist das
  nicht nötig.
- Die Desktop-Oberfläche zeigt den TLS-Grund noch nicht an; der Hinweis steht
  nur im Bridge-Log.
- Node.js respektiert keine OS-seitigen Sperrlisten (Distrust) für fremde
  Zertifikate.
- Verifiziert: lokal auf macOS mit nachgestellter Inspection-Kette
  (`SELF_SIGNED_CERT_IN_CHAIN` reproduziert, `NODE_EXTRA_CA_CERTS`-Weg
  verbindet, `NODE_USE_SYSTEM_CA=1` erweitert die Trust-Liste). Ausstehend:
  Feldtest auf einem Windows-Gerät hinter echter Inspection mit Root-CA im
  Windows-Speicher.

## Relevante Dateien

- `src/electron/services/bridge-process-contract.ts` (Spawn-Umgebung)
- `apps/bridge/src/services/tls-trust-store.ts` (Trust-Store-Status)
- `apps/bridge/src/services/relay-socket-error.ts` (Fehlerklassifikation)
- `apps/bridge/src/services/relay-client.ts` (Fehler-Log)
- `apps/bridge/src/services/runtime-diagnostics.ts` (Startdiagnose)
