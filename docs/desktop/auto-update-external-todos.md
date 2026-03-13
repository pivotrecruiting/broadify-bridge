# Auto-Update: Externe To-dos (außerhalb vom Code)

Diese Punkte musst du außerhalb des Repos erledigen, damit die neue Auto-Update-Implementierung in Produktion funktioniert.

## 1) GitHub Release-Quelle final festlegen
- Aufgabe: Sicherstellen, dass Releases im Repo `pivotrecruiting/broadify-bridge` veröffentlicht werden.
- Warum: Der Updater liest Updates direkt aus GitHub Releases.

## 2) Private-Repo Entscheidung treffen
- Aufgabe: Entscheiden, ob das Release-Repo öffentlich oder privat ist.
- Warum: Bei privatem Repo braucht der Updater ein Token für den Download.
- Wenn privat: `BROADIFY_UPDATER_GITHUB_TOKEN` nur im Main-Prozess sicher bereitstellen (nicht im Renderer).

## 3) Signing/Notarization in GitHub Secrets vollständig halten
- Aufgabe: Prüfen, dass alle Zertifikate/Secrets für macOS und Windows weiterhin gültig sind.
- Warum: Unsignierte oder fehlerhaft signierte Builds dürfen nicht als Update installiert werden.

## 4) Ersten echten End-to-End Update-Test fahren
- Aufgabe: Zwei Versionen veröffentlichen (z. B. `v0.11.0` und `v0.11.1`) und Update von alt -> neu auf echter Maschine testen.
- Warum: Nur so verifizierst du Feed, Download, Restart und Installation in der Realität.

## 5) Support-Runbook bereitstellen
- Aufgabe: Kurze interne Anleitung schreiben für häufige Fälle:
  - "Kein Update gefunden"
  - "Download bleibt hängen"
  - "Signatur-/Installationsfehler"
- Warum: Support kann Probleme schneller einordnen und lösen.

## 6) Release-Checkliste erweitern
- Aufgabe: In eurem Release-Prozess einen Pflichtpunkt ergänzen: "Auto-Update Smoke Test bestanden".
- Warum: Verhindert kaputte Releases mit fehlerhaften `latest*.yml` oder Assets.
