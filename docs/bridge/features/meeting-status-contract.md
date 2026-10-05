# Meeting Status Contract

`meeting_status` ist der Live-Vertrag fuer den Meeting-Zustand. Die Bridge ist
dabei die Single Source of Truth: alle WebApp-Clients spiegeln denselben
Snapshot, statt eigene Meeting-/Recording-/Program-State-Mutationen zu raten.

Der Vertrag ist fuer Multi-Client-Sync gebaut. Ein Client darf nach jedem
`meeting_status` seine lokale View ersetzen; nach Relay-Reconnect kommt derselbe
autoritative Zustand als `meeting_status_snapshot`.

## Event-Envelope

Live-Updates laufen als `bridge_event`:

```jsonc
{
  "type": "bridge_event",
  "bridgeId": "<bridge-id>",
  "event": "meeting_status",
  "data": {
    "reason": "program_update", // string, required, seit Bestand
    "at": 1712345678123, // number, required, Unix ms, seit Bestand
    "status": {} // MeetingStatusT, required, siehe unten
  },
  "timestamp": 1712345678124
}
```

Resync nach `bridge_auth_ok` nutzt dieselbe Relay-Huelle, aber ein Snapshot-Event:

```jsonc
{
  "type": "bridge_event",
  "bridgeId": "<bridge-id>",
  "event": "meeting_status_snapshot",
  "data": {
    "reason": "bridge_auth_ok", // string, required, seit Bestand
    "snapshot": {}, // Result von meeting_get_state, required
    "at": 1712345678123 // number, required, Unix ms
  },
  "timestamp": 1712345678124
}
```

## Status-Form

Neue Felder in dieser Stage-2-Version sind fuer aeltere Clients optional:
`content_source`, top-level `camera_permission_status`, `engine.screen_capture`,
Geometrie/IDs in `engine.program`, `engine.program.media_layer.source`, sowie
`background_asset_id`, `background_template_id` und `background_image_set` in
`keyer.settings`. Neu hinzugefuegte Keys sind `snake_case`. Die bestehenden
Compatibility-Ausnahmen bleiben camelCase: `virtualCamera` und `engineError`.
Das Manager-Objekt traegt zusaetzlich seine historischen camelCase-Keys weiter.

### Laufender Helper

```jsonc
{
  "platform": "darwin", // string, optional, seit Bestand
  "manager": { // object, required, seit Bestand
    "state": "running", // string, required, seit Bestand
    "platform": "darwin", // string, required, seit Bestand
    "port": 52001, // number|null, required, seit Bestand
    "pid": 12345, // number|null, required, seit Bestand
    "framebusName": "broadify-meeting-framebus", // string, required, camelCase, seit Bestand
    "previewPath": "/preview.mjpg", // string, required, camelCase, seit Bestand
    "virtualCamera": {}, // object, required, camelCase, seit Bestand
    "helper": { // object, required, seit Bestand
      "path": "...", // string, required, seit Bestand
      "appPath": "...", // string|null, required, camelCase, seit Bestand
      "bundleId": "com.broadify.meeting-helper", // string|null, required, camelCase, seit Bestand
      "teamId": "ABCDE12345", // string|null, required, camelCase, seit Bestand
      "codeSignatureStatus": "valid", // string, required, camelCase, seit Bestand
      "cameraEntitlementStatus": "present", // string, required, camelCase, seit Bestand
      "microphoneEntitlementStatus": "present", // string, required, camelCase, seit Bestand
      "tccIdentity": "com.broadify.meeting-helper" // string|null, required, camelCase, seit Bestand
    },
    "lastError": null // string|null, required, camelCase, seit Bestand
  },
  "engine": { // object|null, required, seit Bestand
    "bridge_running": true, // boolean, required, seit Bestand
    "camera_running": true, // boolean, required, seit Bestand
    "camera_stalled": false, // boolean, required, seit Bestand
    "preview_running": true, // boolean, required, seit Bestand
    "active_camera_index": 0, // number|null, required, seit Bestand
    "pip_camera_index": null, // number|null, required, seit Bestand
    "auto_director_enabled": false, // boolean, required, seit Bestand
    "keyer_enabled": true, // boolean, required, seit Bestand
    "pipeline_mode": "live", // string, required, seit Bestand
    "keyer_provider": "vision_sequence", // string|null, required, seit Bestand
    "gpu_adapter": "Apple M2", // string|null, required, seit Bestand
    "dml_queue": null, // string|null, required, seit Bestand
    "dml_path": null, // string|null, required, seit Bestand
    "compositor_adapter": "Apple M2", // string|null, required, seit Bestand
    "preview_clients": 1, // number, required, seit Bestand
    "vcam_clients": 1, // number, required, seit Bestand
    "framebus_running": true, // boolean, required, seit Bestand
    "program_dirty": false, // boolean, required, volatil, seit Bestand
    "graphics_dirty": false, // boolean, required, volatil, seit Bestand
    "program_revision": 42, // number, optional fuer aeltere Clients, seit Bestand
    "program": { // object, optional fuer aeltere Clients, Summary seit Stage 2
      "media_layer": {
        "enabled": true, // boolean, required in Summary, seit Stage 2
        "mode": "pip", // string, required in Summary, seit Stage 2
        "page": 1, // number, required in Summary, seit Stage 2
        "page_count": 12, // number, required in Summary, seit Stage 2
        "asset_id": "asset-1", // string|null, required in Summary, seit Stage 2
        "source": "screen", // "page"|"screen"|string, optional fuer aeltere Clients, seit Screen Sharing
        "template_id": "template-1", // string|null, required in Summary, seit Stage 2
        "render_status": "ready", // string|null, required in Summary, seit Stage 2
        "x": 0.1, // number, required in Summary, seit Stage 2
        "y": 0.1, // number, required in Summary, seit Stage 2
        "width": 0.8, // number, required in Summary, seit Stage 2
        "height": 0.8, // number, required in Summary, seit Stage 2
        "rotation": 0, // number, required in Summary, seit Stage 2
        "rotation_x": 0, // number, required in Summary, seit Stage 2
        "rotation_y": 0 // number, required in Summary, seit Stage 2
      },
      "camera_render": {
        "enabled": true, // boolean, required in Summary, seit Stage 2
        "mirror": false // boolean, required in Summary, seit Stage 2
      },
      "speaker_layout": {
        "enabled": true, // boolean, required in Summary, seit Stage 2
        "layout": "right", // "left"|"center"|"right", required in Summary, seit Stage 2
        "scale": 1 // number, required in Summary, seit Stage 2
      },
      "cornerbug": {
        "enabled": true, // boolean, required in Summary, seit Stage 2
        "has_image": true, // boolean, required in Summary, seit Stage 2
        "x": 0.84, // number, required in Summary, seit Stage 2
        "y": 0.08, // number, required in Summary, seit Stage 2
        "size": 0.12, // number, required in Summary, seit Stage 2
        "logo_asset_id": "logo-1" // string|null, required in Summary, seit Stage 2
      },
      "graphics": {
        "enabled": true, // boolean, required in Summary, seit Stage 2
        "graphic_id": "lower-third-1", // string|null, required in Summary, seit Stage 2
        "template": "LowerThird", // string|null, required in Summary, seit Stage 2
        "source": "builder", // string|null, required in Summary, seit Stage 2
        "handoff_target": "meeting_compositor" // string|null, required in Summary, seit Stage 2
      }
    },
    "rendered_frames": 1000, // number, required, volatil, seit Bestand
    "reused_frames": 10, // number, required, volatil, seit Bestand
    "published_preview_frames": 250, // number, required, volatil, seit Bestand
    "written_framebus_frames": 1000, // number, required, volatil, seit Bestand
    "camera_permission_status": "authorized", // string, optional fuer aeltere Clients, seit Stage 2
    "screen_capture": { // object, optional fuer aeltere Clients, seit Screen Sharing
      "running": true, // boolean, required wenn vorhanden
      "picker_pending": false, // boolean, required wenn vorhanden
      "source_id": "display:1", // string|null, required wenn vorhanden
      "kind": "display", // string|null, required wenn vorhanden
      "title": "Built-in Display", // string|null, required wenn vorhanden
      "app_name": null, // string|null, required wenn vorhanden
      "width": 1920, // number|null, required wenn vorhanden
      "height": 1080, // number|null, required wenn vorhanden
      "captured_frames": 123, // number, required wenn vorhanden, volatil
      "last_error": null, // string|null, required wenn vorhanden
      "last_error_at": null, // number|null, required wenn vorhanden
      "capabilities": {
        "supported": true, // boolean, required wenn vorhanden
        "system_picker": true, // boolean, required wenn vorhanden
        "enumeration": true, // boolean, required wenn vorhanden
        "permission_status": "authorized", // string, required wenn vorhanden
        "unsupported_reason": null // string|null, required wenn vorhanden
      }
    },
    "camera_last_error": null, // string|null, required, seit Bestand
    "camera_last_error_at": null, // number|null, required, seit Bestand
    "last_error": null // string|null, required, seit Bestand
  },
  "framebus": { // object, optional, seit Bestand
    "enabled": true, // boolean, required wenn vorhanden, seit Bestand
    "running": true, // boolean, required wenn vorhanden, seit Bestand
    "name": "broadify-meeting-framebus", // string, required wenn vorhanden, seit Bestand
    "last_error": null // null, required wenn vorhanden, seit Bestand
  },
  "keyer": { // object|null, optional, seit Bestand
    "settings": {
      "enabled": true, // boolean, optional, seit Bestand
      "model": "vision_person_segmentation", // "modnet"|"vision_person_segmentation", required aus keyer.get, seit Bestand
      "background_type": "mode", // immer "mode", required aus keyer.get, seit Bestand
      "background_mode": "transparent", // "transparent"|"gradient"|"solid_light"|"checkerboard", required aus keyer.get, seit Bestand
      "background_asset_id": "asset-bg-1", // string|null, optional fuer aeltere Clients, seit Stage 2
      "background_template_id": "template-bg-1", // string|null, optional fuer aeltere Clients, seit Stage 2
      "background_image_set": true, // boolean, optional fuer aeltere Clients, seit Stage 2
      "quality_mode": "balanced", // "fast"|"balanced"|"accurate", required aus keyer.get, seit Bestand
      "performance_mode": "high_quality", // "high_quality"|"quality"|"balanced"|"performance", required aus keyer.get, seit Bestand
      "mask_erode_px": 0, // number, required aus keyer.get, seit Bestand
      "mask_dilate_px": 0, // number, required aus keyer.get, seit Bestand
      "mask_feather_px": 0, // number, required aus keyer.get, seit Bestand
      "dynamic_dilation": false, // boolean, required aus keyer.get, seit Bestand
      "temporal_blend_enabled": true, // boolean, required aus keyer.get, seit Bestand
      "edge_stabilization_enabled": true, // boolean, required aus keyer.get, seit Bestand
      "edge_stabilization_strength": 0.5, // number, required aus keyer.get, seit Bestand
      "fresh_mask_age_ms": 250, // number, required aus keyer.get, seit Bestand
      "max_mask_age_ms": 1000 // number, required aus keyer.get, seit Bestand
    },
    "status": {
      "active_keyer": "vision_person_segmentation", // "modnet"|"vision_person_segmentation"|"passthrough", required, seit Bestand
      "fallback_active": false, // boolean, required, seit Bestand
      "keyer_degraded": false, // boolean, required, seit Bestand
      "keyer_ready": true, // boolean, required, seit Bestand
      "fallback_reason": null, // string|null, required, seit Bestand
      "degradation_stage": "fresh", // string, required, seit Bestand
      "empty_valid": false, // boolean, required, seit Bestand
      "no_subject": false, // boolean, required, seit Bestand
      "compositor": "metal", // string, required, seit Bestand
      "gpu_adapter": "Apple M2", // string|null, required, seit Bestand
      "compositor_adapter": "Apple M2", // string|null, required, seit Bestand
      "stale_mask_active": false, // boolean, required, seit Bestand
      "model": "vision_person_segmentation", // "modnet"|"vision_person_segmentation", required, seit Bestand
      "backend": "vision_person_segmentation", // string, required, seit Bestand
      "quality_mode": "balanced", // "fast"|"balanced"|"accurate", required, seit Bestand
      "performance_mode": "high_quality", // "high_quality"|"quality"|"balanced"|"performance", required, seit Bestand
      "active_performance_mode": null, // string|null, required, auf macOS null, seit Bestand
      "provider": "vision_sequence", // string|null, required, seit Bestand
      "inference_ms": 8.2, // number|null, required, volatil, seit Bestand
      "model_hash_ok": true, // boolean, required, seit Bestand
      "model_path": "...", // string|null, required, seit Bestand
      "pipeline_mode": "live", // string, required, seit Bestand
      "keyer_pipeline_mode": null, // string|null, required, auf macOS null, seit Bestand
      "preview_clients": 1, // number, required, seit Bestand
      "vcam_clients": 1, // number, required, seit Bestand
      "vcam_transport_status": "shm", // string, required, seit Bestand
      "program_dirty": false, // boolean, required, volatil, seit Bestand
      "graphics_dirty": false, // boolean, required, volatil, seit Bestand
      "rendered_frames": 1000, // number, required, volatil, seit Bestand
      "reused_frames": 10, // number, required, volatil, seit Bestand
      "published_preview_frames": 250, // number, required, volatil, seit Bestand
      "written_framebus_frames": 1000, // number, required, volatil, seit Bestand
      "metrics": {} // object, required, volatil; faellt aus stabiler Projektion
    }
  },
  "recording": { // object|null, required, seit Bestand
    "active": true, // boolean, required, seit Bestand
    "file_path": "/Users/.../meeting.mp4.part", // string, required, lokal, seit Bestand
    "elapsed_seconds": 21, // number, required, volatil, seit Bestand
    "video_frames": 630, // number, required, volatil, seit Bestand
    "last_error": "" // string, required, seit Bestand
  },
  "virtualCamera": { // object, optional, camelCase, seit Bestand
    "active": true, // boolean, required wenn Windows-helper Status, seit Bestand
    "supported": true, // boolean, required wenn Windows-helper Status, seit Bestand
    "transport": "shm", // string, required wenn Windows-helper Status, seit Bestand
    "last_error": null // string|null, required wenn Windows-helper Status, seit Bestand
  },
  "call": { // object, required, seit Bestand
    "active": true, // boolean, required, seit Bestand
    "call_id": "call-1" // string|null, required, seit Bestand
  },
  "content_source": { // object, required in Stage 2, optional fuer aeltere Clients
    "video": { // object|null, required in content_source
      "mode": "pip", // "pip"|"fullscreen", required, seit Stage 2
      "x": 0.6, // number, required, seit Stage 2
      "y": 0.6, // number, required, seit Stage 2
      "width": 0.35, // number, required, seit Stage 2
      "height": 0.35, // number, required, seit Stage 2
      "rotation": 0, // number, required, seit Stage 2
      "rotation_x": 0, // number, required, seit Stage 2
      "rotation_y": 0, // number, required, seit Stage 2
      "asset_id": "asset-video-1", // string, required, seit Stage 2
      "muted": false, // boolean, required, default false, seit Stage 2
      "loop": true, // boolean, required, default true, seit Stage 2
      "updated_at": 1712345678000 // number, required, volatil, Unix ms, seit Stage 2
    },
    "browser": {
      "mode": "pip", // "pip"|"fullscreen", required, seit Stage 2
      "x": 0.6, // number, required, seit Stage 2
      "y": 0.6, // number, required, seit Stage 2
      "width": 0.35, // number, required, seit Stage 2
      "height": 0.35, // number, required, seit Stage 2
      "rotation": 0, // number, required, seit Stage 2
      "rotation_x": 0, // number, required, seit Stage 2
      "rotation_y": 0, // number, required, seit Stage 2
      "url": "https://example.invalid/source", // string, required, wird publiziert, nie geloggt, seit Stage 2
      "updated_at": 1712345678000 // number, required, volatil, Unix ms, seit Stage 2
    }
  },
  "camera_permission_status": "authorized" // string|null, required in Stage 2, optional fuer aeltere Clients
}
```

### Gestoppter Helper

Wenn der Helper nicht laeuft oder der Control-Channel transient ausfaellt,
bleibt die Form gleich, aber Engine-nahe Objekte koennen leer sein:

```jsonc
{
  "platform": "darwin", // string, optional, seit Bestand
  "manager": {
    "state": "stopped", // string, required, seit Bestand
    "platform": "darwin", // string, required, seit Bestand
    "port": null, // number|null, required, seit Bestand
    "pid": null, // number|null, required, seit Bestand
    "framebusName": "broadify-meeting-framebus", // string, required, camelCase, seit Bestand
    "previewPath": "/preview.mjpg", // string, required, camelCase, seit Bestand
    "virtualCamera": {}, // object, required, camelCase, seit Bestand
    "helper": { // object, required, seit Bestand
      "path": "...", // string, required, seit Bestand
      "appPath": null, // string|null, required, camelCase, seit Bestand
      "bundleId": null, // string|null, required, camelCase, seit Bestand
      "teamId": null, // string|null, required, camelCase, seit Bestand
      "codeSignatureStatus": "not_checked", // string, required, camelCase, seit Bestand
      "cameraEntitlementStatus": "not_checked", // string, required, camelCase, seit Bestand
      "microphoneEntitlementStatus": "not_checked", // string, required, camelCase, seit Bestand
      "tccIdentity": null // string|null, required, camelCase, seit Bestand
    },
    "lastError": null // string|null, required, camelCase, seit Bestand
  },
  "engine": null, // object|null, required, null wenn Helper nicht erreichbar
  "engineError": "connect ENOENT", // string, optional, camelCase, nur bei Statusfehler
  "recording": null, // object|null, required
  "call": { "active": false, "call_id": null }, // object, required
  "content_source": { "video": null, "browser": null }, // object, required in Stage 2
  "camera_permission_status": null // string|null, required in Stage 2
}
```

## `engine.program` Summary

`engine.program` ist nur die kleine, sync-faehige Projektion fuer Buttons,
Auswahlzustand und Geometrie. Pro Sektion enthaelt sie exakt:

| Sektion | Keys |
| --- | --- |
| `media_layer` | `enabled`, `mode`, `page`, `page_count`, `asset_id`, `source`, `template_id`, `render_status`, `x`, `y`, `width`, `height`, `rotation`, `rotation_x`, `rotation_y` |
| `camera_render` | `enabled`, `mirror` |
| `speaker_layout` | `enabled`, `layout`, `scale` |
| `cornerbug` | `enabled`, `has_image`, `x`, `y`, `size`, `logo_asset_id` |
| `graphics` | `enabled`, `graphic_id`, `template`, `source`, `handoff_target` |

Bewusst nicht enthalten sind Rohdaten wie `image_data_url`, `image_url`,
`rendered_page_path` oder Base64-Bloecke. Grund: `meeting_status` wird
regelmaessig ueber Relay publiziert und darf weder gross noch sensibel werden.
Wer die Rohsektion braucht, ruft `program.get` bzw. `meeting_program_get` fuer
die jeweilige Sektion auf.

## `content_source`

`content_source` beschreibt zwei unabhaengige interne Meeting-Content-Slots:
`video` fuer `meeting-content-video` und `browser` fuer
`meeting-browser-source`. Beide liegen auf der Meeting-Back-Plane und werden
nicht ueber `graphics_status.activePresets` gemeldet.

Die Geometrie-Defaults fuer beide Slots sind `mode: "pip"`, `x: 0.6`,
`y: 0.6`, `width: 0.35`, `height: 0.35`, `rotation: 0`, `rotation_x: 0`,
`rotation_y: 0`. `updated_at` ist volatil und zaehlt nicht als stabile
Statusaenderung. Beim Snapshot reconciled die Bridge gegen die Meeting-Back-
Plane: wurde der interne Layer entfernt, wird der Slot auf `null` gesetzt. Die
Browser-`url` wird publiziert, damit Clients den Zustand spiegeln koennen, sie
darf aber nie in Logs oder Fehlermeldungen interpoliert werden.

## Publish-Kadenz

Die Bridge pollt den Helper alle `STATUS_POLL_INTERVAL_MS` = 2000 ms mit
`reason: "status_poll"`. Eine stabile Projektion entscheidet, ob daraus ein
Relay-Event wird:

- Forced Publish gewinnt immer.
- Wenn `recording.active === true`, wird jeder Poll publiziert, damit
  `elapsed_seconds` und `video_frames` live bleiben.
- Jede Aenderung der stabilen Projektion wird sofort publiziert.
- Nur Counter-/Metric-Aenderungen werden auf
  `STATUS_METRICS_PUBLISH_INTERVAL_MS` = 6000 ms gedrosselt.
- Unveraenderte Snapshots werden nicht publiziert.

Volatile Keys auf beliebiger Tiefe sind `rendered_frames`, `reused_frames`,
`published_preview_frames`, `written_framebus_frames`, `inference_ms`,
`elapsed_seconds`, `video_frames`, `updated_at`, `captured_frames`,
`program_dirty` und `graphics_dirty`; zusaetzlich wird `keyer.status.metrics`
aus der stabilen Projektion entfernt.

`requestStatusPublish(reason)` sammelt Forced-Reasons in einem festen
`STATUS_PUBLISH_COALESCE_MS` = 120-ms-Fenster. Reasons werden per `+`
verbunden, doppelte Reasons dedupliziert, und Forced-Publishes werden
serialisiert.

Belegte Forced-/Edge-Reasons:

- Lifecycle: `engine_started`, `engine_stopped`, `engine_exited`,
  `engine_restarted`.
- Camera-Health: `camera_stalled`, `camera_recovered`,
  `camera_reopen_scheduled`, `camera_reopen_success`,
  `camera_reopen_failure`, `camera_capture_error`, `camera_open_failure`.
- Kamera-Kommandos: `camera_select`, `camera_start`, `camera_stop`,
  `camera_program_select`.
- Kamera-Permission: `camera_permission_preflight`,
  `camera_permission_completed`.
- Screen: `screen_start`, `screen_stop`, `screen_pick`,
  `screen_capture_started`, `screen_capture_stopped`,
  `screen_capture_source_changed`, `screen_capture_picker`,
  `screen_capture_error`.
- Recording: `recording_changed` fuer Start/Stop/Toggle.
- Content: `content_video_set`, `browser_source_set`.
- Keyer/Program/VCam: `keyer_configure`, `keyer_reset`, `program_update`,
  `vcam_auto_armed`, `vcam_start`, `vcam_stop`.

`vcam_client_edge` wird edge-triggered bei VCam-Client Connect/Disconnect
publiziert, aber nicht forced; es nutzt die normale Publish-Policy.

## Multi-Client-Semantik

`program.update` ist Last-Writer-Wins pro Sektion. Es gibt keinen Actor und
keine Revision pro Client. `program_revision` ist monoton, aber kein reiner
Programmzaehler: er dient als Trigger-Revision fuer Programm-, Preview-, VCam-,
Kamera- und Keyer-Ereignisse. Settle-/Echo-Fenster gehoeren deshalb in die
WebApp.

`graphics_status` bleibt der Kanal fuer Meeting-Preset-Spiegelung. Sein
`source` ist `studio`, `meeting-back` oder `meeting-front`; `activePresets`
enthaelt die per `reportPresetId` gemeldeten Presets. Video-/Browser-Content
kommt dagegen ueber `meeting_status.content_source`, nicht ueber
`graphics_status`.

## Keyer-Hintergruende

`keyer.settings` enthaelt in Stage 2 die Hintergrund-Identitaet:
`background_asset_id`, `background_template_id` und `background_image_set`.
Der lokale `background_image_path` wird nie publiziert. Die IDs sind
Identity-Metadaten und nicht Teil der Keyer-Signatur; eine reine ID-Aenderung
loest keinen Keyer-Reset aus. `keyer.configure` behandelt
`background_image_path`, `background_asset_id` und `background_template_id`
presence-guarded: fehlt ein Feld, bleibt der aktuelle Wert erhalten.

## Kompatibilitaet

Aeltere WebApps ignorieren unbekannte Keys. Neuere WebApps muessen alle
Stage-2-Felder optional behandeln, insbesondere `content_source`,
`camera_permission_status`, `engine.screen_capture`,
`engine.program.media_layer.source`, `engine.program.*`-Erweiterungen und die
Keyer-Hintergrund-IDs.

Quellen fuer die belegten Keys: `meeting-status-types.ts`, `meeting-content-source-state.ts`,
`meeting-helper-manager.ts`, `meeting-command-handler.ts`,
`status-publish-policy.ts`, `relay-client.ts` und der native
`control_server.cpp` aus den Stage-2-Sibling-Worktrees.
