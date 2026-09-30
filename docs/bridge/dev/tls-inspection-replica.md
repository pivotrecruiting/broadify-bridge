# Dev-Setup: TLS-Inspection nachstellen („Pförtner")

Ziel: Das Verhalten der Bridge hinter einer Firmen-Firewall mit SSL-Inspection
reproduzieren, ohne so eine Firewall zu besitzen. Hintergrund und Kundenfall:
`docs/bridge/support/relay-tls-trust-runbook.md`.

Das Kit liegt in `scripts/tls-inspection-replica/`:

- `make-ca.sh <relay-host>` erzeugt eine Wegwerf-Root-CA („Broadify Test
  Inspection Root CA (DO NOT TRUST IN PRODUCTION)", 30 Tage gültig) und ein
  Server-Zertifikat für den Relay-Host. Die Kette enthält absichtlich die
  selbstsignierte Root, genau wie bei einer echten Inspection-Firewall.
- `proxy.mjs --relay-host <relay-host>` spielt den Pförtner: nimmt die
  Verbindung mit der gefälschten Kette an und leitet den WebSocket-Verkehr
  1:1 an den echten Relay weiter (Upstream per IP mit korrektem SNI und Host,
  DNS-Auflösung direkt über den DNS-Server, damit ein Hosts-Eintrag nicht in
  den Proxy zurückschleift).

Voraussetzungen: Repo-Checkout mit `npm ci` im Root (liefert `ws`), Node 18+,
`openssl` (macOS eingebaut, Windows über Git for Windows / Git Bash).

## Relay-Host ermitteln

Aus dem Bridge-Log des zu testenden Builds: `[Relay] Connecting to relay at
wss://<relay-host>...`. RC-Builds nutzen den RC-Relay, Live-Builds
`broadify-relay.fly.dev`. Der Host unten heißt durchgehend `<relay-host>`.

## Stufe 1: Ein Rechner, nur der TLS-Schritt (15 Minuten)

Prüft genau die Stelle, an der es beim Kunden hakt, plus die Anmeldung der
Bridge am Relay. Das Pairing selbst läuft in dieser Stufe nicht durch: Die
Bridge prüft die JWKS-URL des Relays gegen private Adressen, und der
Hosts-Eintrag lässt den Relay-Host auf `127.0.0.1` zeigen (Log: `JWKS URL
resolves to private address`). Für das komplette Pairing siehe Stufe 2.

1. Zertifikate erzeugen: `scripts/tls-inspection-replica/make-ca.sh <relay-host>`
2. Pförtner starten (Port 443 braucht auf macOS `sudo`, auf Windows eine
   Administrator-Shell):
   `node scripts/tls-inspection-replica/proxy.mjs --relay-host <relay-host> --listen 127.0.0.1:443`
3. Hosts-Eintrag `127.0.0.1 <relay-host>` setzen (macOS `/etc/hosts` mit
   `sudo`, Windows `C:\Windows\System32\drivers\etc\hosts` als Administrator).
4. Bridge starten, Log lesen. Erwartet, solange die Fake-CA nicht vertraut ist
   (alter und neuer Build gleichermaßen):
   `[Relay] WebSocket error: self signed certificate in certificate chain (code: SELF_SIGNED_CERT_IN_CHAIN) ...`
   Im Proxy-Log: `client ... rejected our certificate during the TLS handshake`.
5. Fake-Root in den OS-Speicher importieren (siehe unten), Bridge komplett neu
   starten. Erwartet mit v0.27.1-rc.18 oder neuer:
   `[RuntimeDiagnostics] TLS trust store {"systemCaEnabled":true,...}` und
   `[Relay] Connected to relay server`; im Proxy-Log `client connected` und
   `upstream connected`. Ein älterer Build (rc.17) muss weiter mit
   `SELF_SIGNED_CERT_IN_CHAIN` scheitern.
6. Aufräumen: Hosts-Eintrag entfernen, CA entfernen (siehe unten), Proxy
   beenden, `scripts/tls-inspection-replica/out/` löschen.

## Stufe 2: Echtes Pairing durch den Pförtner (zwei Rechner)

Aufbau wie beim Kunden: DNS bleibt unverändert, der Verkehr zur Relay-IP wird
auf dem Weg abgefangen. Ein Mac im selben LAN ist die Zwischenstation, das
Testgerät (Windows-Laptop, alternativ zweiter Mac) schickt nur den Verkehr zur
Relay-IP über diesen Mac. Alles andere läuft normal über die Fritzbox.

Mac (Zwischenstation, LAN-IP zum Beispiel `192.168.178.20`, Interface meist
`en0`, prüfen mit `route get default`):

```bash
scripts/tls-inspection-replica/make-ca.sh <relay-host>
node scripts/tls-inspection-replica/proxy.mjs --relay-host <relay-host> --listen 0.0.0.0:8443
# zweites Terminal:
RELAY_IP=$(dig +short <relay-host> A | head -1); echo "$RELAY_IP"
sudo sysctl -w net.inet.ip.forwarding=1
printf 'rdr pass on en0 inet proto tcp from <laptop-ip> to %s port 443 -> 127.0.0.1 port 8443\n' "$RELAY_IP" \
  | sudo tee /tmp/broadify-replica.pf
sudo pfctl -f /tmp/broadify-replica.pf && sudo pfctl -e
```

Testgerät Windows (PowerShell als Administrator, `fake-corp-root.cer` vom Mac
kopieren):

```powershell
route add <relay-ip> mask 255.255.255.255 <mac-ip> metric 1
# IPv6 auf dem aktiven Adapter für die Dauer des Tests deaktivieren, sonst
# umgeht die Bridge die Route über IPv6 und der Test wirkt fälschlich grün.
certutil -addstore -f Root .\fake-corp-root.cer        # Computer-Speicher
# alternativ ohne Adminrechte: certutil -user -addstore Root .\fake-corp-root.cer
```

Testgerät macOS (zweiter Mac):

```bash
sudo route add -host <relay-ip> <mac-ip>
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain fake-corp-root.pem
```

Ablauf und Erwartung:

1. Zuerst ohne CA-Import: Bridge (alt oder neu) muss `SELF_SIGNED_CERT_IN_CHAIN`
   loggen, der Proxy `rejected our certificate`. Erscheint im Proxy-Log gar
   nichts, greift die Route nicht (IPv6 aktiv? falsche IP? falsches Interface?).
2. CA importieren, Bridge neu starten: v0.27.1-rc.18 oder neuer verbindet
   (`Connected to relay server`), Pairing in der Webapp funktioniert, im
   Proxy-Log läuft der komplette Verkehr durch. rc.17 muss weiter scheitern.
3. Gegenprobe: `NODE_USE_SYSTEM_CA=0` als System-Umgebungsvariable setzen,
   Bridge neu starten: auch der neue Build muss scheitern und im Log
   `"systemCaEnabled":false` zeigen. Danach Variable wieder entfernen.

Aufräumen:

```powershell
route delete <relay-ip>
certutil -delstore Root "Broadify Test Inspection Root CA (DO NOT TRUST IN PRODUCTION)"
# bzw. certutil -user -delstore Root "..."; IPv6 wieder aktivieren
```

```bash
# Mac Zwischenstation
sudo pfctl -f /etc/pf.conf && sudo pfctl -d
sudo sysctl -w net.inet.ip.forwarding=0
rm -rf scripts/tls-inspection-replica/out
# zweiter Mac als Testgerät
sudo route delete -host <relay-ip>
sudo security delete-certificate -c "Broadify Test Inspection Root CA (DO NOT TRUST IN PRODUCTION)" /Library/Keychains/System.keychain
```

## Sicherheitshinweise

- Der Pförtner sieht den Klartext der Relay-Verbindung, wie eine echte
  Inspection-Firewall. Nur mit Testkonten und Test-Bridges arbeiten.
- Die Fake-CA nie auf Produktivgeräten installieren und nach dem Test
  entfernen. Die privaten Schlüssel liegen nur in `out/` (gitignored).
- `NODE_TLS_REJECT_UNAUTHORIZED=0` ist kein Testmittel und wird nirgends
  benutzt.

## Verifikationsstand

- Getestet (23.9.2026, macOS): `make-ca.sh` und `proxy.mjs` gegen den echten
  Live-Relay mit einem Client, der sich wie die Bridge verhält (Electron als
  Node, echte `ws`-Bibliothek). Ohne vertraute CA: `SELF_SIGNED_CERT_IN_CHAIN`,
  Close 1006. Mit vertrauter CA: Verbindung läuft durch den Pförtner, der Relay
  antwortet auf `bridge_hello` (für die Test-Bridge-ID erwartungsgemäß mit
  `bridge_auth_error`).
- Nicht ausgeführt: die pf-Umleitung und Host-Route aus Stufe 2 sowie der
  CA-Import in Windows-/macOS-Speicher. Diese Schritte folgen den
  dokumentierten Standardwegen (mitmproxy-Transparent-Setup für macOS, Windows
  `route`/`certutil`), sind aber vor dem ersten Einsatz einmal zu bestätigen.
