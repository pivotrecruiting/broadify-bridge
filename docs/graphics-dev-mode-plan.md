Graphics Dev Mode Plan

Ziel
- Development-Mode schaltet Output-Validierung/Device-Checks aus, damit der Renderer ohne Hardware getestet werden kann.

Schritte
1) Klären, was mit „Webapp“ gemeint ist (Electron UI in `src/ui` oder separate Webapp) und finalen Env-Var-Namen bestätigen.
2) Bridge: zentralen Dev-Mode-Flag aus Env einführen; Output-Validierung konditional deaktivieren; bei Dev-Mode auf Stub-Output umleiten.
3) Webapp: Dev-Mode-Flag aus Env (`DEVELOPMENT`) lesen; UI-Validierungen/Output-Setup anpassen (Stub-Config, Test-Flow).
4) Logs/Doku: Dev-Mode im Log markieren; Security-Risiken dokumentieren (nur lokal/Dev).
