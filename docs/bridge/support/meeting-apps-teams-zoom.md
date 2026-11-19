# Support-Runbook: Bildqualität in Teams und Zoom

Für Support und Kunden-IT. Stand der Recherche: 28.09.2026. Vendor-Verhalten
ändert sich: Teams und Zoom passen Videoauflösung, Bitrate und Verarbeitung
laufend an App-Version, Konto-/Tenant-Policy, CPU, Bandbreite und Layout an.
Die Zahlen unten sind deshalb keine Broadify-Garantie, sondern die in den
verlinkten Quellen beschriebene Erwartung.

## 1. Was Broadify liefert

| Pfad | Erwartung | Nachweis |
|---|---|---|
| Virtuelle Kamera | macOS: ab VCam-Build 20 `1920x1080` bei 30 fps, BGRA/Programmbild. Windows lieferte bereits `1920x1080@30`. | macOS: `systemextensionsctl list | grep broadify` zeigt `(1.0/20)`; Windows/SHM: siehe [Virtual Camera Windows](../features/virtual-camera-windows.md). |
| Aufnahme | Laut Repo-Doku: `1080p30` CFR, H.264 High, BT.709, ca. 22 Mbit/s; daraus grob ca. 10 GB/h. | Mit `ffprobe` prüfen, siehe Abschnitt 6 und [Meeting Recording](../features/meeting-recording.md). |
| Webapp-Vorschau | Die Vorschau ist verkleinert. Sie kann dadurch subjektiv schärfer wirken als das 1:1-Bild in der Meeting-App. | Einschätzung aus UI-Verhalten; nicht als Qualitätsnachweis verwenden. |

Wichtig: Wenn QuickTime, Windows Kamera oder `ffprobe` lokal 1080p zeigen,
liefert Broadify die hohe Auflösung. Was danach beim Gegenüber ankommt, liegt
in der Meeting-App und im Netzwerkpfad.

## 2. Was die Meeting-App daraus macht

Teams und Zoom senden nicht stur den Kamera-Input weiter. Einschätzung:
Meeting-Apps kodieren, skalieren und priorisieren adaptiv nach Bandbreite, CPU,
Teilnehmerzahl, Fenstergröße und Meeting-Layout. Microsoft beschreibt in der
Azure-Communication-Services-Doku Simulcast als mehrere Qualitätsstufen, aus
denen die Infrastruktur pro Empfänger passend auswählt:
[1080p, 720p, 540p, 360p, 240p und 180p](https://learn.microsoft.com/en-us/azure/communication-services/concepts/voice-video-calling/simulcast).
Die Übertragung dieses Simulcast-Modells auf Teams ist Broadify-Einschätzung.

| Beobachtung | Bedeutung |
|---|---|
| Selbstansicht sieht gut aus, Gegenüber sieht weicheres Bild | Einschätzung: Selbstansicht ist nicht zwingend der remote gesendete Stream. |
| Galerieansicht wirkt matschig | Einschätzung auf Basis des Simulcast-Modells: In Galerie-Kacheln werden oft 720p, 540p oder weniger ausgeliefert, weil der Empfänger das Video klein rendert. |
| Ein Teilnehmer sieht besseres Bild als ein anderer | Einschätzung auf Basis des Simulcast-Modells: Simulcast/Adaptive Video kann pro Empfänger eine andere Stufe liefern. |
| Recording sieht anders aus als Live | Einschätzung: Meeting-App-Aufnahmen haben eigene Regeln und sind nicht identisch mit der lokalen Broadify-Aufnahme. |

Diese Entscheidungen sind nicht durch Broadify steuerbar. Broadify kann nur ein
sauberes 1080p-Programmbild an die virtuelle Kamera und an die lokale Aufnahme
liefern.

## 3. Teams

Einschätzung: Microsoft Teams bietet keine normale Nutzer-Einstellung, mit der
eine feste Sendeauflösung erzwungen wird. Laut Microsoft-Q&A optimiert Teams bei
genug Bandbreite bis zu 1080p und 30 fps, passt die Qualität aber an Netzwerk
und Gerät an: [1080p on Microsoft Teams](https://learn.microsoft.com/en-us/answers/questions/4398515/1080p-on-microsoft-teams).

| Thema | Empfehlung |
|---|---|
| Höhere Sende-Stufe | Broadify-Teilnehmer spotlighten oder bei relevanten Empfängern anpinnen. Größer gerenderte Videos können eine höhere Simulcast-Stufe anfordern. Diese Wirkung ist eine Einschätzung aus dem Simulcast-Modell, keine Microsoft-Garantie. |
| Kontrolle im Meeting | In Teams die Anrufintegrität öffnen und gesendete Auflösung, Framerate und Bitrate prüfen: [Überwachen der Anruf- und Besprechungsqualität in Teams](https://support.microsoft.com/de-de/office/7bb1747c-d91a-4fbb-84f6-ad3f48e73511). |
| Admin-Policy | Kunden-IT soll die Meeting-Richtlinie für Medienbitrate prüfen. Zu niedrige Policies begrenzen die erreichbare Qualität: [Media bit rate policy](https://learn.microsoft.com/en-us/microsoftteams/meeting-policies-audio-and-video). |
| Filter | `Soft focus` und `Adjust brightness` ausschalten. Der Microsoft-365-Message-Center-Post MC352623 beschreibt laut Petri/adaQuest-Spiegel beide Filter und dass sie standardmäßig aus sind: [Petri: MC352623](https://petri.com/microsoft-changelog/m365-changelog-soft-focus-and-adjust-brightness-in-teams-video-meetings/), [adaQuest: MC352623](https://www.adaquest.com/soft-focus-and-adjust-brightness-in-teams-video-filters/). Microsoft beschreibt die Filter auch in der Teams-Hilfe: [Use video in Microsoft Teams](https://support.microsoft.com/en-us/teams/meetings/use-video-in-microsoft-teams). |
| Kamera nach VCam-Update | Teams einmal schließen, wieder öffnen und `Broadify Camera` neu auswählen. |
| Teams-Aufnahme | Keine Broadify-Garantie für die Teams-Aufnahme: Speicherort, Player und Microsoft-Verarbeitung bestimmen die Qualität. Die lokale Broadify-Aufnahme ist davon unabhängig, siehe [Meeting Recording](../features/meeting-recording.md). Hintergrund: [High quality video of Teams meeting recording](https://learn.microsoft.com/en-us/answers/questions/4423721/high-quality-video-of-teams-meeting-recording). |

Wenn Teams trotz 1080p-VCam nur 720p sendet, ist das zunächst kein Broadify-
Fehler. Einschätzung: Entscheidend sind Teams-Statistik, Tenant-Policy, Layout
und Upload.

## 4. Zoom

Zooms `HD`-Schalter in den Videoeinstellungen bedeutet nicht automatisch
1080p. Zoom beschreibt für HD/Gruppen-HD mehrere Voraussetzungen:
[Enabling HD video for Zoom Meetings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0066166).

| Thema | Empfehlung |
|---|---|
| Normales HD | In Zoom: Einstellungen -> Video -> `HD` aktivieren. Das ist typischerweise 720p. |
| 1080p | Nur mit passender Konto-Freigabe, z. B. Business/Enterprise, aktivierter Gruppen-HD-Freigabe und Aktivierung durch Zoom-Support. Einschätzung: In der Praxis oft nur in Sprecheransicht erreichbar. |
| Bandbreite | Zoom nennt laut KB0066166 ca. 2 Mbit/s für HD/720p. Für 1080p-Gruppen-HD nennt Zoom mindestens 3,0 Mbit/s Empfang und 3,8 Mbit/s Senden; für stabilere Broadify-Meetings mindestens 4 Mbit/s Upload-Reserve einplanen. Die 4 Mbit/s sind Broadify-Einschätzung. |
| Virtueller Hintergrund | Zoom deckelt Video ohne Greenscreen laut Quelle auf 720p, teils niedriger. Broadify-Keyer statt Zoom-Hintergrund nutzen. |
| Kontrolle im Meeting | Einschätzung: Zoom: Statistik -> Video prüfen, insbesondere Sendeauflösung und fps. |

Wenn Zoom 720p sendet, obwohl Broadify 1080p liefert, ist das bei Standard-HD
laut KB0066166 erwartbar. 1080p muss kontoseitig und durch Zoom-Support
freigeschaltet sein.

## 5. Prüfen, ob die Kamera 1080p liefert

### macOS

1. QuickTime Player öffnen.
2. Ablage -> Neue Filmaufnahme.
3. Neben dem Aufnahmeknopf `broadify Camera` wählen.
4. Eine kurze Aufnahme speichern.
5. Informationen anzeigen und `1920 x 1080` prüfen.

Zusätzlich:

```bash
systemextensionsctl list | grep broadify
```

Erwartet ab VCam-Build 20: eine aktivierte Broadify-Zeile mit `(1.0/20)`.
Wenn die Kamera nach einem Update in Teams/Zoom fehlt, die Meeting-App neu
starten und die Kamera erneut auswählen.

### Windows

1. Windows Kamera-App öffnen.
2. `Broadify Camera` auswählen.
3. Einstellungen -> Videoqualität öffnen.
4. `1080p` auswählen bzw. prüfen.

Für Feldläufe zusätzlich `state.get`/Helper-Events prüfen: Die Eingangskamera
öffnet einen 1080p-Nativtyp, wenn `camera_native_media_type_selected`
`width:1920`, `height:1080` und `fps` nahe 30 meldet.

## 6. Aufnahmequalität prüfen

Die lokale Broadify-Aufnahme ist unabhängig davon, was Teams oder Zoom live
ausliefern. Eine fertige `.mp4` kann so geprüft werden:

```bash
ffprobe -hide_banner -select_streams v:0 -show_entries stream=codec_name,profile,bit_rate,avg_frame_rate,r_frame_rate,color_space,color_transfer,color_primaries -of default=noprint_wrappers=1 recording.mp4
```

Erwartung laut [Meeting Recording](../features/meeting-recording.md):

| Feld | Erwartung |
|---|---|
| `width` / `height` | `1920` / `1080` |
| `avg_frame_rate` | `30/1` |
| `profile` | H.264 High |
| `bit_rate` | ungefähr `22000000` Bit/s |
| `color_primaries` | `bt709` |

Speicherbedarf: ca. 10 GB/h. Das ist eine Faustzahl aus 22 Mbit/s Video plus
Audio/Container-Overhead; je nach Encoder-Metadaten und Laufzeit leicht
abweichend.

## 7. Gestaltung für Downscale

Einschätzung: Teams und Zoom skalieren häufig auf 720p oder darunter. Außerdem
wird Meeting-Video üblicherweise mit 4:2:0-Chroma kodiert; dünne farbige Kanten
verlieren dabei zuerst Schärfe. Die folgenden Werte sind Broadify-Einschätzung
für robuste Lower Thirds auf einem 1080p-Canvas:

| Element | Mindestwert |
|---|---|
| Haupttext | mindestens 40 px Schriftgröße |
| Neben-/Labeltext | mindestens 32 px, besser 36 px |
| Linien/Trenner | mindestens 3 px |
| Farbige Kanten | nicht als einzige Lesbarkeitskante verwenden; lieber helle/dunkle Kontrastfläche |
| Kontrast | hoher Helligkeitskontrast, nicht nur Farbkontrast |

Vor Kundenterminen ein kurzes Testmeeting mit Galerieansicht und Sprecheransicht
machen. Wenn Text in 720p nicht sicher lesbar ist, Preset vergrößern, nicht auf
eine höhere Meeting-App-Stufe hoffen.

## 8. Checkliste: Bild wirkt matschig

| Check | Gut | Nächster Schritt |
|---|---|---|
| VCam-Build | macOS `(1.0/20)` oder neuer; Windows VCam meldet 1080p. | VCam-Runbook prüfen: `docs/bridge/support/vcam-runbook.md`. |
| App-Statistik | Teams/Zoom senden 1080p oder mindestens 720p bei stabilen fps. | Einschätzung: Wenn niedriger, Layout, Policy, Bandbreite und CPU prüfen. |
| Upload | Stabil mindestens 4 Mbit/s Reserve. | LAN statt WLAN testen; parallele Uploads schließen. Diese Schwelle ist Broadify-Einschätzung. |
| Teams-Filter | `Soft focus` und `Adjust brightness` aus. | In Teams Device Settings/Video Settings prüfen. |
| Layout | Broadify-Teilnehmer ist spotlighted/gepinnt oder groß sichtbar. | Galerie-Kachel vermeiden, wenn Textqualität kritisch ist. |
| Zoom-Hintergrund | Kein Zoom-Virtual-Background ohne Greenscreen. | Broadify-Keyer verwenden. |
| Betrachter-Display | Kein Browser-/OS-Zoom, keine Mini-Kachel, keine starke Display-Skalierung. | Empfängeransicht großziehen oder Sprecheransicht verwenden. |
| Preset | Text mindestens 40 px, Linien mindestens 3 px, hoher Kontrast. | Lower Third vergrößern und erneut in 720p prüfen. |

## 9. Paste-fertiger Support-Text

Broadify liefert die virtuelle Kamera auf macOS ab VCam-Build 20 als 1080p-
Signal mit 30 fps; Windows lieferte 1080p30 bereits vorher. Die lokale
Broadify-Aufnahme ist laut Repo-Doku ebenfalls auf 1080p30 ausgelegt. Teams und
Zoom senden dieses Bild aber nicht unverändert weiter; Einschätzung: Sie
skalieren und kodieren abhängig von Bandbreite, CPU, Teilnehmerzahl, Konto-/
Tenant-Regeln und Meeting-Layout. Einschätzung: In Galerieansichten sehen
Empfänger deshalb oft 720p, 540p oder weniger, obwohl die Broadify-Kamera lokal
1080p liefert. Bitte prüfen Sie in Teams die Anrufintegrität bzw. als
Einschätzung in Zoom Statistik -> Video, welche Auflösung tatsächlich gesendet
wird. In Teams sollten `Soft focus` und `Adjust brightness` ausgeschaltet sein;
in Zoom sollte `HD` aktiv sein und für 1080p muss das Konto durch Zoom-Support
entsprechend freigeschaltet sein. Bitte nutzen Sie bei kritischen Grafiken
Spotlight/Sprecheransicht oder Pinning und vermeiden Sie Zooms virtuellen
Hintergrund ohne Greenscreen. Für Lower Thirds empfehlen wir auf dem 1080p-
Canvas mindestens 40 px Schriftgröße, starke Kontraste und Linien ab 3 px.
