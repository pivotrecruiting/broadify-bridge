# Graphics Realtime Refactor – Überblick

## Zweck
Diese Dokumente beschreiben den kompletten Realtime-Refactor der Graphics-Pipeline mit Fokus auf flüssige 50 fps und minimale Latenz. Der Plan trennt strikt Control-Plane (Bridge) und Data-Plane (Frame-Transport).

## SSOT (Single Source of Truth)
- Output-Format Payload: `apps/bridge/src/services/graphics/graphics-schemas.ts`
- Output-Validierung (DeckLink): `apps/bridge/src/services/graphics/graphics-manager.ts`
- Output-Policy (Pixel-Formate): `apps/bridge/src/services/graphics/output-format-policy.ts`
- Device/Port-Modell: `packages/protocol/src/index.ts`
- Display-Output Helper: `apps/bridge/src/services/graphics/display/display-output-entry.ts`

## Dokumente
- Ziele & Constraints: `docs/bridge/refactor/graphics-realtime-goals.md`
- Architektur: `docs/bridge/refactor/graphics-realtime-architecture.md`
- Dataflow: `docs/bridge/refactor/graphics-realtime-dataflow.md`
- FrameBus (Shared Memory): `docs/bridge/refactor/graphics-realtime-framebus.md`
- FrameBus API Spec: `docs/bridge/refactor/graphics-realtime-framebus-api.md`
- FrameBus C/C++ Header: `docs/bridge/refactor/graphics-realtime-framebus-c-header.md`
- FrameBus N-API API: `docs/bridge/refactor/graphics-realtime-framebus-napi-api.md`
- Renderer-Design: `docs/bridge/refactor/graphics-realtime-renderer.md`
- Renderer Command Contract: `docs/bridge/refactor/graphics-realtime-renderer-command-contract.md`
- Output-Helper: `docs/bridge/refactor/graphics-realtime-output-helpers.md`
- Output Helper Contract: `docs/bridge/refactor/graphics-realtime-output-helper-contract.md`
- Migrationsplan & Dateiliste: `docs/bridge/refactor/graphics-realtime-migration-plan.md`
- **Legacy Removal Plan (No Rollback):** `docs/bridge/refactor/legacy-removal-plan.md`
- **Display Native Helper Migration:** `docs/bridge/refactor/display-native-helper-migration-plan.md`

## Status
- Phase 0: Architektur entschieden und dokumentiert.
- Phase 1: Implementierung startet nach Freigabe.
- Plattform-Status: macOS only (Windows/Linux deferred).

## Festgelegte Entscheidungen
- CSS-Isolation: Shadow DOM pro Layer.
- Legacy-Pfade werden vollständig entfernt (siehe `legacy-removal-plan.md`).
- Key/Fill ist ARGB8-only. BGRA ist nicht erlaubt.
