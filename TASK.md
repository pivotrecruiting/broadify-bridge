# Task: Kunden-/Support-Doku "Bildqualität in Teams und Zoom" (PR E, docs-only)

## Raw request
Gabriel (Product Owner, 1./2.10.2026): Teil des Plans "besseres Bild live + Recording, Grafik echt 1080p". Nachdem Bridge-seitig die Virtual Camera 1920x1080 meldet (VCam-Build 20, PR #221), Grafiken 2x supersampled werden (PR #222) und Aufnahmen 0,35 bit/px, BT.709 und 30 fps CFR haben (PR #225), bleibt die Verschlechterung durch die Meeting-App selbst. Diese Doku erklärt Support und Kunden, was Teams/Zoom mit dem Bild machen und was man dagegen tun kann.

## Context
- Customer / project: Broadify Bridge, Support-Doku unter `docs/bridge/support/`
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/meeting-apps-quality-docs, feature/meeting-apps-quality-docs
- Base branch: dev (573454e5)
- Recherchierte Fakten (28.9.2026, Quellen unten): Teams optimiert bis 1080p/30 fps je nach Bandbreite, liefert "HD unter 1,5 Mbit/s", nutzt Simulcast (Stufen 1080p/720p/540p/360p/240p/180p), die gesendete Auflösung hängt davon ab, wie groß die Empfänger das Video rendern (Spotlight/Anpinnen → größer → höhere Stufe); Teams-Videofilter "Soft focus" (Weichzeichner) und "Adjust brightness" existieren, Standard aus; Teams-Aufnahmen in OneDrive/SharePoint sind 1080p, in Stream geringer. Zoom: "HD" in den Videoeinstellungen = 720p; 1080p nur Business/Enterprise auf Anfrage (Gruppen-HD), ~2 Mbit/s, bei virtuellem Hintergrund ohne Greenscreen Deckel 720p. Broadify selbst: VCam 1920x1080 BGRA 30 fps (ab Build 20), Aufnahme 1080p30 CFR ≈ 22 Mbit/s H.264 BT.709 (≈ 10 GB/h).
- Quellen (im Dokument verlinken, Zahlen nicht als Broadify-Garantie formulieren): https://learn.microsoft.com/en-us/azure/communication-services/concepts/voice-video-calling/simulcast ; https://learn.microsoft.com/en-us/answers/questions/4398515/1080p-on-microsoft-teams ; https://support.microsoft.com/en-us/teams/meetings/use-video-in-microsoft-teams ; https://petri.com/microsoft-changelog/m365-changelog-soft-focus-and-adjust-brightness-in-teams-video-meetings/ ; https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0066166 ; https://learn.microsoft.com/en-us/answers/questions/4423721/high-quality-video-of-teams-meeting-recording

## Plan
1. Neue Datei `docs/bridge/support/meeting-apps-teams-zoom.md` (Deutsch, Stil wie `docs/bridge/support/vcam-runbook.md`: Überschrift, Zielgruppe "Support und Kunden-IT", Tabellen, Kommandos in Codeblöcken). Gliederung:
   1. Was Broadify liefert (VCam 1920x1080@30 ab VCam-Build 20; Aufnahme 1080p30 CFR, ≈ 22 Mbit/s H.264 High, BT.709, ≈ 10 GB/h; Vorschau in der Webapp ist verkleinert und wirkt deshalb schärfer als 1:1).
   2. Was die Meeting-App daraus macht (Sendeauflösung adaptiv nach Bandbreite, CPU, Teilnehmerzahl und Layout; Empfänger sehen in der Galerie oft 720p/540p oder weniger; Selbstansicht ≠ Remote-Bild; nicht durch Broadify beeinflussbar).
   3. Teams: keine Nutzer-Einstellung für die Sendeauflösung; Spotlight/Anpinnen des Broadify-Teilnehmers erhöht die gesendete Stufe; "Anrufintegrität"/Anrufdaten zeigen Sende-Auflösung und Bitrate; Admin-Meeting-Richtlinie (Medienbitrate); Videofilter "Soft focus" und "Adjust brightness" ausschalten; Kamera nach einem VCam-Update in Teams einmal neu auswählen; Teams-Aufnahme: OneDrive/SharePoint 1080p.
   4. Zoom: Einstellungen → Video → "HD" aktivieren (720p); 1080p nur mit Konto-Freigabe (Business/Enterprise, Gruppen-HD), meist nur in der Sprecheransicht; virtueller Hintergrund ohne Greenscreen deckelt auf 720p (Broadify-Keyer statt Zoom-Hintergrund nutzen); Statistik → Video zeigt Sendeauflösung/fps.
   5. Prüfen, ob die Kamera 1080p liefert: macOS QuickTime "Neue Filmaufnahme" mit "broadify Camera" (Aufnahme → Informationen zeigen 1920x1080) und `systemextensionsctl list | grep broadify` → `(1.0/20)`; Windows Kamera-App → Einstellungen → Videoqualität 1080p.
   6. Aufnahmequalität prüfen: ffprobe-Zeile aus `docs/bridge/features/meeting-recording.md` übernehmen (Auflösung, `avg_frame_rate 30/1`, `bit_rate`, `color_primaries bt709`); Speicherbedarf ≈ 10 GB/h.
   7. Gestaltung für Downscale: Mindestschriftgrößen für Lower Thirds (Faustregel: Schrift ≥ 40 px auf dem 1080p-Canvas, Linien ≥ 3 px, hoher Kontrast), weil Teams/Zoom auf 720p oder weniger skalieren und 4:2:0-Chroma dünne farbige Kanten verwischt.
   8. Checkliste "Bild wirkt matschig": VCam-Build ≥ 20, App-Statistik (gesendete Auflösung), Upload ≥ 4 Mbit/s stabil (LAN statt WLAN), Soft-Focus aus, Spotlight/Pin, Display-Skalierung beim Betrachter, Preset-Schriftgrößen.
   9. Paste-fertiger Support-Text (DE, 6–8 Sätze) für Kundenantworten.
   Hinweis-Box am Anfang: Vendor-Verhalten ändert sich; Quellen mit Datum (28.9.2026) verlinken.
2. Verlinkung: `docs/bridge/support/vcam-runbook.md` (im macOS-Abschnitt und in der Eskalation ein Satz "Bildqualität in Teams/Zoom → meeting-apps-teams-zoom.md"), `docs/bridge/features/meeting-field-checklist.md` (Zeile zum Teams-Bild, falls vorhanden; sonst kurzer Eintrag), `docs/bridge/README.md` (Index-Eintrag unter Support).
3. Keine Code-Änderungen. Keine Zahlen erfinden; was nicht aus den Quellen oder dem Repo belegt ist, als Einschätzung kennzeichnen.

## Acceptance criteria
1. `docs/bridge/support/meeting-apps-teams-zoom.md` existiert mit den 9 Abschnitten, Deutsch, Quellen verlinkt, Datum der Recherche genannt.
2. Verlinkungen in `vcam-runbook.md`, `meeting-field-checklist.md` und `docs/bridge/README.md` vorhanden.
3. Keine Änderungen außerhalb von `docs/`. `npm run lint` bleibt grün (Docs sind nicht gelintet, Kommando trotzdem einmal ausführen).

## Review
- Round: 2/3
- Verdict: PASS nach Runde 2 (Runde 1 Verifier 2.10.2026: Struktur/Verlinkung/Lint PASS, Fakten FAIL → 4 MUST-FIX; Runde 2 Fixes durch Codex, Spot-Check durch Orchestrator: Zoom 2 Mbit/s → HD/720p, 1080p 3,0/3,8 Mbit/s; Teams-Aufnahme-Zahl gestrichen; Capture-Event als Eingangskamera; Einschätzungs-Markierungen + Microsoft-Links; `npm run lint` Exit 0).
- Must-fix (open): keine
- Must-fix (resolved in Runde 2):
  1. Z. 69 Zoom: "~2 Mbit/s" gehört laut KB0066166 zum HD-Setting (720p); 1080p braucht mind. 3,0 Mbit/s Empfang / 3,8 Mbit/s Senden.
  2. Z. 54 Teams-Aufnahme "OneDrive/SharePoint 1080p": Q&A 4423721 sagt das nicht; einzige Fundstelle ist eine Tech-Community-Antwort (MVP, 3.11.2020). Als Community-Angabe (2020) kennzeichnen und verlinken oder neutral formulieren.
  3. Z. 103-105 `camera_native_media_type_selected` ist das Event der Eingangskamera (`camera_mediafoundation.cpp`), nicht der VCam → als "Eingangskamera öffnet 1080p-Nativtyp" formulieren.
  4. Unbelegte Aussagen kennzeichnen/belegen: Simulcast-Stufen stammen aus der Azure-Communication-Services-Doku (Übertragung auf Teams = Einschätzung); "keine Nutzer-Einstellung für Sendeauflösung" (Einschätzung); Zoom "meist nur Sprecheransicht" (Einschätzung); Anrufintegrität und Medienbitrate-Policy mit Quellen belegen (https://support.microsoft.com/de-de/office/7bb1747c-d91a-4fbb-84f6-ad3f48e73511 ; https://learn.microsoft.com/en-us/microsoftteams/meeting-policies-audio-and-video); Zoom "Statistik → Video" kennzeichnen.
- Notes (non-blocking, in Runde 2 mit erledigt, wenn billig): "ab VCam-Build 20" nur macOS (Windows lieferte schon 1080p); ffprobe-Zeile an `meeting-recording.md` angleichen + Link; "Broadify-Release-Kontext" durch Verweise auf Repo-Doku ersetzen; Soft-Focus-Default dem MC352623-Post zuordnen; Zoom "muss durch Zoom-Support aktiviert werden"; `->` statt `→`; Support-Text: "Anrufintegrität" als UI-Begriff.
- Handoff to human (if any): Petri-Link per WebFetch 403 (Bot-Sperre), inhaltlich durch MC352623-Spiegel gedeckt; deutsche UI-Labels der Teams-Filter unverifiziert.

## Verification
- [ ] Doku-Review durch Verifier (Fakten gegen Quellen und Repo, Links auflösbar, Stil)
- [ ] `npm run lint` grün
