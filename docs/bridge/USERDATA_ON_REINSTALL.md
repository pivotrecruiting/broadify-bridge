# Bridge-Daten bei Update / Neuinstallation

Wo liegt alles? In Electrons `userData`-Verzeichnis — getrennt nach Kanal:

- **Produktion:** `~/Library/Application Support/Broadify Bridge/`
- **RC:** `~/Library/Application Support/Broadify Bridge RC/`

Die App (`.app`-Bundle in `/Applications`) und dieser Datenordner sind **voneinander unabhängig**.

---

## Kernaussage: Was wird gelöscht?

| Vorgang | Was passiert mit den Daten |
|---|---|
| **Auto-Update** (electron-updater / „Quit & Install") | **Nichts gelöscht.** Nur das `.app`-Bundle wird ersetzt. |
| **Manuelle Neuinstallation** (DMG/ZIP, App nach `/Applications` ziehen & ersetzen) | **Nichts gelöscht.** macOS fasst `Application Support` beim App-Austausch nicht an. |
| **„Cleane" Neuinstallation** (App löschen **und** den `Application Support`-Ordner manuell entfernen) | **Alles** unten Gelistete weg. |
| **Kanalwechsel** RC ↔ Produktion | Nichts gelöscht, aber die App liest einen **anderen** Ordner → Daten wirken „verloren" (liegen aber noch im jeweils anderen Ordner). |

> Es gibt **kein** Skript und keinen Uninstaller in diesem Projekt, das/der `userData` automatisch löscht. Datenverlust passiert nur durch **manuelles** Entfernen des Ordners oder durch einen Kanalwechsel.

---

## Datenkategorien im `userData`-Ordner

### A) Wichtige Nutzdaten — schmerzhaft bei Verlust (nur bei manuellem Ordner-Löschen weg)

| Datei / Ordner | Inhalt |
|---|---|
| `network-config.json` | Netzwerk-/Mixer-Konfiguration (ATEM etc.). Wird beim ersten Start aus dem Template kopiert. |
| `bridge-id.json` | Stabile Bridge-ID (UUID). Neu → die Bridge gilt für Backend/Relay als andere Instanz. |
| `bridge-profile.json` | Vom Nutzer gesetzter Bridge-Name + Zeitpunkt der AGB-Zustimmung (`termsAcceptedAt`). Verlust → Name weg, AGB müssen erneut akzeptiert werden. |
| `security/relay-bridge-identity.json` | Relay-Identität / Pairing (Datei-Rechte `0600`). Verlust → Bridge muss sich neu mit dem Relay verbinden/pairen. |
| `graphics-output.json` | Grafik-Ausgabe-Konfiguration (Zielbildschirm, Auflösung …). |
| `graphics-assets/` + `assets.json` | Hochgeladene Grafik-Assets (Lower Thirds, Bilder …) und deren Manifest. |
| `graphics/` | Arbeits-/Ablageverzeichnis der Grafik-Engine. |
| `graphics-renderer-profile/` | Isoliertes Electron-Profil des Offscreen-Graphics-Renderers. Enthält nur Renderer-Runtime-/Chromium-State. |
| `.env` | Lokale Env-Overrides (z. B. `RELAY_URL`). Wird im Prod-Build ohnehin aus dem Paket nachgefüllt/überschrieben. |
| `.updaterId` | Installations-ID des Updaters. |

### B) Web-/UI-Status — technisch Nutzdaten, regeneriert sich aber

| Datei / Ordner | Inhalt |
|---|---|
| `Local Storage/`, `Session Storage/` | UI-Status & Auto-Connect-Einstellungen des Renderers. Wird bei erneuter Verbindung neu aufgebaut. |
| `Cookies`, `SharedStorage`, `Shared Dictionary/` | Web-Storage des Renderers. |

### C) Wegwerf-Daten — Chromium/Electron-intern, baut sich automatisch neu auf

`Cache/`, `Code Cache/`, `GPUCache/`, `DawnGraphiteCache/`, `DawnWebGPUCache/`,
`Network Persistent State`, `TransportSecurity`, `Trust Tokens`, `DIPS*`,
`Preferences`, `blob_storage/`, `Crashpad/`, `sentry/` (Crash-Reports),
`Singleton*` (Runtime-Locks), `logs/` + `app.log` / `bridge.log` / `bridge-process.log`.

Zusätzlich gilt innerhalb von `graphics-renderer-profile/`: `GPUCache/`, `Code Cache/`,
`DawnGraphiteCache/`, `DawnWebGPUCache/`, `ShaderCache/` und `GrShaderCache/` sind
volatile Renderer-Caches. Die Bridge darf diese nach einem Renderer-Absturz automatisch
löschen, nachdem der Renderer-Prozess vollständig beendet wurde.

→ Diese können bedenkenlos gelöscht werden; sie werden beim nächsten Start neu erzeugt.

---

## Praxis-Empfehlung

- **Normales Update/Reinstall:** Daten bleiben erhalten — nichts zu tun.
- **Vor einer cleanen Neuinstallation sichern:** `network-config.json`, `bridge-id.json`,
  `bridge-profile.json`, `security/relay-bridge-identity.json`, `graphics-output.json`
  und `graphics-assets/`.
- **RC zum Testen:** RC und Produktion teilen sich **keine** Daten (eigener Ordner) —
  ideal, um produktive Konfiguration nicht zu beeinflussen.

---

## Troubleshooting: `Invalid bridge auth signature`

**Symptom:** Die Bridge verbindet sich zum Relay, fliegt aber sofort wieder raus:

```
[Relay] Relay bridge auth failed: Invalid bridge auth signature
[Relay] Disconnected from relay server (code: 1006)
```

**Ursache:** Bridge-Identität besteht aus **zwei gekoppelten Teilen**, die zusammengehören:

- `bridge-id.json` — die `bridgeId`. Daraus wird der `keyId` abgeleitet (`bridge-<id[0:8]>-1`).
- `security/relay-bridge-identity.json` — das ed25519-**Keypair** (Private Key).

Der Relay hat beim Pairing den **Public Key** zu diesem `keyId` gespeichert. Existiert die
`bridgeId` ohne ihr ursprüngliches Keypair, generiert die Bridge ein **neues** Keypair unter
demselben `keyId` → die Signatur passt nicht mehr zum serverseitig hinterlegten Public Key.
Häufigste Auslöser: nur das Keypair gelöscht, oder eine Migration, die die ID ohne den Key
kopiert (genau dieser Bug wurde in `app-bootstrap.ts` behoben — ID + Key migrieren jetzt nur
noch atomar).

**Fix A — Auth ohne Re-Pairing wiederherstellen (wenn das alte Keypair noch existiert):**
Das alte Keypair zurück ins aktive Profil kopieren, App neu starten:

```bash
AS="$HOME/Library/Application Support"
cp "$AS/<quell-profil>/security/relay-bridge-identity.json" \
   "$AS/Broadify Bridge[ RC]/security/relay-bridge-identity.json"
```

**Fix B — Frische Identität + Re-Pairing (wenn kein altes Keypair vorhanden):**
Bridge beenden, dann `bridge-id.json` **und** `security/relay-bridge-identity.json` löschen
(und ggf. die alte Bridge in der Web-App entfernen), neu starten → neue ID + neues Keypair →
in der Web-App neu pairen.

> Merke: `bridge-id.json` und `security/relay-bridge-identity.json` **immer gemeinsam**
> sichern/wiederherstellen. Eines ohne das andere bricht die Relay-Auth.
