# RØDECaster Video Integration (Engine `rodecaster`)

Stand: 2026-09-28. Die Bridge steuert den RØDE-Videomischer **RØDECaster
Video** (Modelle: Video / Video S / Video Core) als Studio-Engine — analog zu
ATEM/vMix/Tricaster — und spielt Broadify-Grafiken über den bestehenden
HDMI-Ausspielweg zu.

## Steuerung (OSC über TCP)

- **Transport:** OSC über TCP, Default-Port **10024**. Jedes OSC-Paket trägt
  einen 4-Byte-**Little-Endian**-Längenprefix (die OSC-Payload selbst ist
  spec-konform Big-Endian). Kein SLIP.
- **Adapter:** `apps/bridge/src/services/engine/adapters/rodecaster-adapter.ts`
  (Codec: `rcv-osc.ts`, Framing: `rcv-frame-codec.ts`).
- **Subscription:** Nach dem Connect sendet der Adapter `/show` und `/remote`.
  Das Gerät antwortet mit einem XML-Dump (`RcvShow`, als OSC-Blob) und pusht
  danach Zustandsänderungen (`/show/pgmcurrent`, `/show/PgmOverlay`,
  `/show/record`, `/show/live`).
- **Geräteinfo:** Best-effort Unicast-UDP-Probe (`RodeBroadcast`) an Port
  9999; die XML-Antwort (`RcvDevice`) liefert Name/Firmware/Modell und wird
  nur geloggt (ohne Seriennummer).
- **Kein Adapter-interner Reconnect:** Bei Verbindungsverlust fällt der
  Adapter auf `error`; den Reconnect übernimmt der
  `EngineConnectionSupervisor` (Backoff, Self-Heal) oberhalb des Adapters.
- **Firmware-Voraussetzungen:** Fernsteuerung (Companion/StreamDeck-Pfad) ab
  Firmware **1.0.06.748** (Dez 2024); „Video-Eingang als Overlay" ab
  **1.2.04.1163** (Aug 2025). Gerät und Bridge-Rechner müssen im selben Netz
  sein; ein Freischalt-Toggle am Gerät ist nicht nötig.

## Makro-Katalog (stabile ID-Räume)

Der Adapter exponiert synthetische Makros; IDs werden nie umgewidmet, Lücken
sind für Folgearbeiten reserviert.

| IDs   | Makro                    | OSC-Kommando                                |
| ----- | ------------------------ | ------------------------------------------- |
| 1–7   | Scene 1–7                | `/device/scene <n>`                         |
| 11–17 | Overlay 1–7 Toggle       | `/device/toggleOverlay <n>`                 |
| 21–27 | Media 1–7                | `/device/media <n>`                         |
| 31/32 | Cut / Auto               | `/device/button 105|106 1`                  |
| 41    | Transition Fade          | `/show/transition fade`                     |
| 42    | Transition Dip           | `/show/transition dip` + `dipBlack`         |
| 43    | Transition Wipe          | `/show/transition wipe` + `leftright`       |
| 51/52 | Record Start / Stop      | `/show/record 1|0`                          |
| 53/54 | Stream Start / Stop      | `/show/live 1|0`                            |

Reserviert: 61+ (System), 71+ (Spezial-Buttons Key/Inspect/Multisource), 81+
(Transition-Zeit-Presets).

**Status-Feedback:** Die live geschaltete Szene (bzw. Media/Overlay) und
aktive Record/Stream-Zustände werden als Makro-Status `running` gemeldet und
landen über den bestehenden Broadcast-Diff auf Buttons/StreamDeck.

**Toggle-Verhalten:** Die Controls-UI sendet für ein laufendes Makro
`engine_stop_macro` statt `run`. Der Adapter nutzt das als Toggle-Off:
Klick auf ein aktives Overlay togglet es aus, Klick auf „Record Start"
während einer Aufnahme stoppt sie (`/show/record 0`), analog Stream. Szenen/
Media/Cut/Auto/Transitions sind momentane Makros — `stop` ist dort ein No-op.

**Modelle:** Alle drei Modelle adressieren 7 Szenen/Overlays/Media-Slots über
das Remote-Protokoll; nicht belegte Slots sind am Gerät No-ops. Das erkannte
Modell wird geloggt; eine modellabhängige Katalog-Beschneidung ist
vorbereitete Folgearbeit.

## Grafik-Zuspielung (HDMI + Key am Gerät)

Broadify-Grafiken erreichen den RØDECaster über den bestehenden
`video_hdmi`-Ausspielweg (Display-Device → nativer SDL2 `display-helper`,
opak, kein Alpha):

1. **Verkabelung:** HDMI-Ausgang des Bridge-Rechners → freier HDMI-Eingang
   des RØDECaster.
2. **Am Gerät:** Den Grafik-Eingang einem **Overlay-Button** zuweisen
   (Video-Input als Overlay, FW ≥ 1.2.04.1163) und Keying aktivieren:
   - **Chroma-Key (empfohlen):** Die Bridge rendert Grafiken für opake
     Outputs auf **Grün (#00FF00)** — sowohl das Idle-Bild
     (`session-background.ts`, `DEFAULT_OPAQUE_BACKGROUND_MODE`) als auch
     Layer mit „transparentem" Preset-Hintergrund (Webapp-Mapping
     `mapBackgroundToMode`: `transparent → green` für `video_hdmi`/
     `video_sdi`). Am RØDECaster den Chroma-Key auf Grün stellen.
   - **Luma-Key (Alternative):** Für Grafiken mit Grünanteilen: Preset-
     Hintergrund in der Webapp auf **Schwarz** stellen und Bridge-seitig
     `BRIDGE_GRAPHICS_IDLE_BACKGROUND=black` setzen; am Gerät Luma-Key
     aktivieren (stanzt dunkle Bereiche).
3. **Overlay togglen:** Wahlweise am Gerät oder über Makro 11–17.

**Grenzen/Ausbau:** 8-bit-HDMI + Kantenglättung kann Farbsäume erzeugen; der
sauberste Weg wäre NDI mit Alphakanal (Geräte-Firmware ≥ 1.3.02), die Bridge
hat aber bewusst noch keinen NDI-Ausgang (`key_fill_ndi` ist Stub). Ein frei
konfigurierbarer `clearColor` existiert im Renderer-Contract und ist als
Ausbaustufe notiert.

## Registrierungsstellen des Engine-Typs

Bridge: `engine-adapter-interface.ts`, `engine-connect-schema.ts`,
`adapter-factory.ts`, `engine-types.ts`, `runtime-config.ts`,
`packages/protocol/src/index.ts` (+ getracktes `dist/`).
Webapp: `types/engine-types.ts`, `app/api/connections/preferences/route.ts`,
Supabase-Migration `20260928120000_add_rodecaster_engine_type.sql`
(CHECK-Constraints beider Preferences-Tabellen), Dashboard
`engine-section.tsx` (Auswahl + Port-Default 10024).
Die Electron-Desktop-UI kennt (wie bei Tricaster) den Typ bewusst nicht;
verbunden wird über die Webapp.

## Offene Folgearbeiten

- UDP-Discovery (Port 9999) als echte Geräte-Suche statt manueller IP.
- Modellabhängige Katalog-Beschneidung (RCV S / Core).
- Transition-Zeit-Makros (81+), Spezial-Buttons (71+).
- Desktop-UI-Eintrag, NDI-Alpha-Ausspielweg.

## Protokoll-Quelle

RØDE veröffentlicht keine offizielle API. Die OSC-Adressen und das Framing
sind aus dem Open-Source-Companion-Modul `bitfocus/companion-module-rode-rcv`
extrahiert (Fakten, kein Code übernommen); die eingehenden Status-Formate
sind dort in `src/events/recievedDataHandler.ts` dokumentiert.
