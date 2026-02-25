# Relay Caller Auth Setup (WebApp → Relay)

Dieses Runbook beschreibt die Einrichtung der **Caller-Assertion-Authentifizierung** für WebApp → Relay: Die WebApp signiert Requests mit einem Ed25519-Privatkey, das Relay verifiziert mit dem zugehörigen Public Key. Die Keys sind **getrennt** von den Relay→Bridge Signing Keys (`RELAY_SIGNING_*`).

## Übersicht

| Komponente   | Repo / Deployment | Env mit Key        |
|-------------|-------------------|--------------------|
| WebApp      | broadify (Vercel) | Private Key        |
| Relay       | broadify-relay (Fly) | Public Key     |

## 1. Ed25519-Keypair erzeugen

### Option A: OpenSSL (manuell)

```bash
# Private Key
openssl genpkey -algorithm Ed25519 -out relay-caller-webapp-private.pem

# Public Key
openssl pkey -in relay-caller-webapp-private.pem -pubout -out relay-caller-webapp-public.pem
```

**Einzeilig für Env-Variablen** (PEM mit `\n` als Literal, damit es in einer Zeile gesetzt werden kann):

```bash
# Private Key einzeilig (für RELAY_CALLER_SIGNING_PRIVATE_KEY)
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' relay-caller-webapp-private.pem

# Public Key einzeilig (für RELAY_CALLER_ASSERTION_PUBLIC_KEY)
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' relay-caller-webapp-public.pem
```

### Option B: Skript im Repo

```bash
./scripts/gen-relay-caller-keys.sh
```

Das Skript erzeugt die PEM-Dateien und gibt die einzeiligen Werte für die Env-Variablen aus.

---

## 2. Umgebungsvariablen

### WebApp (broadify, Vercel)

| Variable | Pflicht (Prod) | Beschreibung |
|----------|----------------|--------------|
| `RELAY_CALLER_SIGNING_PRIVATE_KEY` | Ja | PEM des Ed25519-Privatkeys (einzeilig mit `\n` ok) |
| `RELAY_CALLER_SIGNING_KID` | Nein | Key-ID, Standard: `webapp-1` |
| `RELAY_CALLER_ASSERTION_TTL_SECONDS` | Nein | TTL der Assertion in Sekunden, Standard: `30` |
| `RELAY_REQUIRE_CALLER_ASSERTION` | Nein | In Prod effektiv default true |

### Relay (broadify-relay, Fly)

| Variable | Pflicht (Prod) | Beschreibung |
|----------|----------------|--------------|
| `RELAY_CALLER_ASSERTION_PUBLIC_KEY` | Ja | PEM des Ed25519-Public Keys (einzeilig mit `\n` ok) |
| `RELAY_CALLER_ASSERTION_KID` | Nein | Key-ID, muss zu WebApp `RELAY_CALLER_SIGNING_KID` passen, Standard: `webapp-1` |
| `RELAY_CALLER_ASSERTION_TTL_SECONDS` | Nein | TTL in Sekunden, Standard: `30` |
| `RELAY_REQUIRE_CALLER_ASSERTION` | Nein | In Prod effektiv default true |

**Wichtig:** `RELAY_CALLER_SIGNING_KID` (WebApp) und `RELAY_CALLER_ASSERTION_KID` (Relay) müssen übereinstimmen (z.B. beide `webapp-1`). Diese Keys sind **nicht** `RELAY_SIGNING_PRIVATE_KEY` (Relay→Bridge).

---

## 3. Deployment

### Vercel (broadify – WebApp)

Private Key nur in Production/Preview als Secret setzen, nicht in Logs oder UI exponieren.

```bash
# Ersetze <PRIVATE_KEY_ONE_LINE> durch die einzeilige PEM-Ausgabe (siehe oben)
vercel env add RELAY_CALLER_SIGNING_PRIVATE_KEY production
# Bei Aufforderung: <PRIVATE_KEY_ONE_LINE> einfügen

# Optional
vercel env add RELAY_CALLER_SIGNING_KID production
# Wert: webapp-1

vercel env add RELAY_CALLER_ASSERTION_TTL_SECONDS production
# Wert: 30
```

Oder in Vercel Dashboard: Project → Settings → Environment Variables.

### Fly.io (broadify-relay – Relay)

```bash
# In das Relay-App-Verzeichnis wechseln (broadify-relay)
cd /pfad/zu/broadify-relay

# Public Key setzen (einzeilige PEM)
fly secrets set RELAY_CALLER_ASSERTION_PUBLIC_KEY="<PUBLIC_KEY_ONE_LINE>"

# Optional
fly secrets set RELAY_CALLER_ASSERTION_KID="webapp-1"
fly secrets set RELAY_CALLER_ASSERTION_TTL_SECONDS="30"
```

Nach `fly secrets set` startet Fly die App neu.

---

## 4. Empfohlene Werte

| Variable | Wert |
|----------|------|
| `RELAY_CALLER_SIGNING_KID` / `RELAY_CALLER_ASSERTION_KID` | `webapp-1` |
| `RELAY_CALLER_ASSERTION_TTL_SECONDS` | `30` |

---

## 5. Verifizierung

- WebApp: Beim Senden von `POST /relay/command` wird die Caller-Assertion mit dem Private Key signiert.
- Relay: Verifiziert Signatur, TTL und Replay (jti) mit dem Public Key; nur bei Erfolg wird der Command an die Bridge weitergeleitet.
- Ohne gesetzte Keys bzw. mit `RELAY_REQUIRE_CALLER_ASSERTION=false` kann der Codepfad je nach Konfiguration Requests ohne Assertion annehmen (nur für Dev/Local empfohlen).

---

## 6. Referenzen

- `docs/security/relay-data-traffic.md` – Datenfluss WebApp → Relay → Bridge
- `docs/security/gdpr-implementation-plan.md` – Phase 1 Caller-Auth Rollout
