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
    "lastError": null, // string|null, required, camelCase, seit Bestand
    "program_format": { "width": 1920, "height": 1080, "fps": 30 } // object|null, optional fuer aeltere Clients, seit Hochformat (ADR-0007)
  },
  "engine": { // object|null, required, seit Bestand
    "bridge_running": true, // boolean, required, seit Bestand
    "camera_running": true, // boolean, required, seit Bestand
    "camera_stalled": false, // boolean, required, seit Bestand
    "camera_format": { "width": 1920, "height": 1080, "fps": 30, "requested_fps": 60, "match": "half_rate" }, // object|null, optional fuer aeltere Clients, seit 50/60 fps (ADR-0010)
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
      "fallback_active": false, // boolean, required, seit Bestand; seit B-11 auch true bei macOS CoreML->Vision-Downgrade (s. u.)
      "keyer_degraded": false, // boolean, required, seit Bestand; folgt fallback_active (ausser fallback_reason "keyer_disabled")
      "keyer_ready": true, // boolean, required, seit Bestand; false nur bei fallback_reason "loading"/"not_loaded"
      "fallback_reason": null, // string|null, required, seit Bestand; bei CoreML->Vision-Downgrade der CoreML-Grund (s. u.)
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
      "model_hash_ok": true, // boolean|null, required; null = dieses Backend prueft keinen Hash (CoreML/Vision auf macOS), seit B-11 (vorher immer false auf macOS)
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
    "codec": "h264", // string|null, additiv seit Nov 2026 (ADR-0010); MeetingRecordingCodecT der laufenden bzw. letzten Aufnahme, null vor dem ersten Start
    "container": "mp4", // string|null, additiv seit Nov 2026 (ADR-0010); "mp4" | "mov", folgt aus codec
    "elapsed_seconds": 21, // number, required, volatil, seit Bestand
    "video_frames": 630, // number, required, volatil, seit Bestand
    "audio_samples_written": 2100, // number|null, additiv seit Okt 2026 (B-9), volatil; nur der Windows-Helper zaehlt. macOS und Stub melden immer null, auch waehrend Ton aufgenommen wird: null heisst "nicht gezaehlt", nicht "kein Ton"
    "audio_samples_dropped": 3, // number|null, additiv seit Okt 2026 (B-9), volatil; Samples vor Session-Start verworfen (siehe meeting-recording.md); wie audio_samples_written nur unter Windows eine Zahl, macOS/Stub immer null
    "disk_space_low": null, // object|null, additiv seit Nov 2026; { required_bytes, free_bytes } nach einem mit recording_disk_space_low abgelehnten Start
    "last_error": "" // string, required, seit Bestand; Fehler der laufenden bzw. letzten Aufnahme oder des letzten gescheiterten Starts, "" nach einer sauber abgeschlossenen Aufnahme. "finalize_timeout" wenn stop() den Finalize-Schritt nach kRecorderFinalizeTimeoutMs abbricht (.part bleibt). Ein mit already_recording abgelehnter Start aendert das Feld nicht
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
  "camera_permission_status": "authorized", // string|null, required in Stage 2, optional fuer aeltere Clients
  "program_format": { // object|null, optional fuer aeltere Clients, seit Hochformat (ADR-0007)
    "width": 1080, // number, required wenn vorhanden
    "height": 1920, // number, required wenn vorhanden
    "fps": 30 // number, required wenn vorhanden
  }
}
```

#### `program_format` und Hochformat (ADR-0007)

- `program_format` ist die Geometrie der **laufenden** Engine: die Optionen des
  `meeting_engine_start`, der den aktuellen Helper-Prozess erzeugt hat, mit den
  Defaults `1920x1080@30` aufgefuellt. `null`, solange die Engine nicht laeuft.
  Derselbe Wert steht in `manager.program_format`, damit auch das Ergebnis von
  `meeting_engine_start` (Manager-Status) ihn traegt.
- `height > width` ist ein Hochformat-Programm. Ob die Bridge das kann, sagt
  `get_status.capabilities.meeting.program_portrait` (macOS `true`, Windows
  vorerst `false`; fehlt auf aelteren Bridges).
- `meeting_engine_start` mit Hochformat ohne diese Capability:
  `errorCode: "meeting_program_portrait_unsupported"`.
- `meeting_engine_start` ausserhalb von
  `get_status.capabilities.meeting.program_formats` (zu grosse Leinwand oder
  eine Bildrate, die nicht in `fps` steht):
  `errorCode: "meeting_program_format_unsupported"`, ohne `data`. Die Pruefung
  kommt nach der Hochformat-Pruefung und gilt auch bei laufender Engine - ein
  Neustart wuerde das Format nicht moeglich machen. Siehe
  [Programmformate und Aufnahme-Faehigkeiten](#programmformate-und-aufnahme-faehigkeiten-adr-0010).
- `meeting_engine_start` bei laufender Engine: gleiche Breite, Hoehe **und
  Bildrate** bleibt idempotent (Erfolg, Manager-Status); weicht eines der drei
  ab, kommt `errorCode: "meeting_engine_restart_required"` mit dem
  Manager-Status in `data`. Die Bridge startet nie selbst neu; die Web-App
  sendet `meeting_engine_stop` und danach `meeting_engine_start`. Laeuft eine
  Aufnahme, nennt `error` das - der Stop wuerde sie beenden. Die Bildrate
  gehoert seit ADR-0010 zum Vergleich; davor war ein Start mit anderer
  Bildrate erfolgreich und liess die alte Bildrate stehen.
- `meeting_engine_start` waehrend ein Start mit anderem Format (Breite, Hoehe
  oder Bildrate) noch laeuft (zweiter Client, Crash-Restart): die Antwort
  wartet auf diesen Start. Laeuft die Engine danach, kommt
  `meeting_engine_restart_required` mit deren Manager-Status; scheitert er,
  kommt sein Fehler ohne `errorCode`.
- Eine Ablehnung (`meeting_program_portrait_unsupported`,
  `meeting_program_format_unsupported`, `meeting_engine_restart_required`)
  aendert nichts: Engine, Aufnahme, Grafik-FrameBus, Renderer und
  Grafik-Ebenen bleiben, wie sie sind.
- `meeting_graphics_configure_outputs` folgt der Engine-Geometrie, wenn die
  Ausrichtung der Anfrage von der laufenden Engine abweicht; `data.width` /
  `data.height` nennen die tatsaechlich konfigurierte Groesse.
- `content_source.*`-Bruchteile beziehen sich im Hochformat auf die
  Hochformat-Buehne (Groesse der Grafik-Ebenen), im Querformat wie bisher auf
  `1920x1080`.
- `get_status.capabilities.meeting.layer_canvas` (`true` auf allen Plattformen,
  fehlt auf aelteren Bridges): `graphics_send` wertet `canvas { width, height }`
  aus, die Groesse der Ebenen-Box vor der Layout-Transformation. Ohne `canvas`
  bleibt die Box `1920x1080`. Details: `graphics-commands.md`, ADR-0007.

#### `engine.camera_format` (ADR-0010)

Was die Programmkamera liefert, unveraendert aus dem Helper (`state.get`)
durchgereicht:

```jsonc
{
  "width": 1920, // number, aktive Breite des Geraets
  "height": 1080, // number, aktive Hoehe des Geraets
  "fps": 30.00003, // number, aktive Bildrate des Geraets (Geraete melden 30 als 30.00003)
  "requested_fps": 60, // number, angeforderte Rate = Bildrate des Programms
  "match": "half_rate" // "exact" | "tolerant" | "half_rate" | "nearest" | "none"
}
```

- `null`, solange keine Kamera laeuft, und auf Plattformen, deren
  Kamera-Backend das Format nicht meldet (heute Windows). Fehlt auf aelteren
  Bridges.
- Die Werte sind zurueckgelesen, nachdem die Kamera laeuft, nicht die
  Anforderung. `match` sagt, wie das Format gewaehlt wurde: `exact` /
  `tolerant` = angeforderte Rate, `half_rate` = halbe Rate in der
  angeforderten Groesse (nur ueber 30 fps: 60 -> 30, 50 -> 25), `nearest` =
  naechstliegende Rate (ueber 30 fps zuerst in der angeforderten Groesse:
  1080p30 statt 720p60 im 50-fps-Programm), `none` = das Geraet hat die Auswahl nicht uebernommen
  und laeuft mit dem Format der Session-Voreinstellung.
- Liefert die Kamera weniger als das Programm
  (`Math.round(camera_format.fps) < program_format.fps`), laeuft das Programm
  trotzdem mit der eingestellten Rate; jedes Kamerabild wird wiederholt, bei
  `half_rate` genau zweimal. Aufnahme, Grafik und Bildschirminhalte haben die
  volle Rate. Das ist kein Fehler und keine Ablehnung; die Web-App zeigt
  einen Hinweis.

#### Programmformate und Aufnahme-Faehigkeiten (ADR-0010)

`get_status.capabilities.meeting` traegt drei weitere, optionale Felder
(`MeetingCapabilitiesT` in `packages/protocol`). Aeltere Bridges liefern sie
nicht; die Web-App behandelt ein fehlendes Feld als "nicht unterstuetzt".

```jsonc
{
  "program_portrait": true,
  "layer_canvas": true,
  "program_formats": { // object, optional, seit ADR-0010
    "max_width": 1920, // number, groesste Breite einer Querformat-Leinwand
    "max_height": 1080, // number, groesste Hoehe einer Querformat-Leinwand
    "fps": [25, 30, 50, 60], // number[], zulaessige Bildraten (macOS; sonst [25, 30])
    "keyer_max_fps": 30 // number, optional, seit Nov 2026; hoechste Programm-Bildrate, bei der Keying laeuft
  },
  "recording_probe": "done", // "pending" | "done" | "failed", optional, Zustand der Encoder-Probe
  "recording": { // object, optional, seit ADR-0010; steht genau bei recording_probe "done"
    "codecs": [ // leer: kein Hardware-Encoder gefunden
      { "codec": "h264", "container": "mp4", "max_height": 1080, "max_fps": 60 },
      { "codec": "hevc", "container": "mp4", "max_height": 1080, "max_fps": 60 },
      { "codec": "prores_422", "container": "mov", "max_height": 1080, "max_fps": 60 }
    ],
    "upload_copy": false // boolean, Bridge kann eine Kopie der Aufnahme hochladen
  }
}
```

- `program_formats` begrenzt `meeting_engine_start`. `max_width`/`max_height`
  gelten fuer eine Querformat-Leinwand; eine Hochformat-Leinwand wird mit
  vertauschten Kanten gemessen (lange Kante gegen `max_width`, kurze gegen
  `max_height`) und braucht zusaetzlich `program_portrait`. Kleinere
  Leinwaende bleiben erlaubt. Heute `1920x1080` auf allen Plattformen, mit 25
  und 30 fps; unter macOS zusaetzlich 50 und 60 fps
  (`MEETING_PROGRAM_FORMAT_LIMITS` in
  `services/meeting/meeting-capabilities.ts`). Windows bleibt bei 25/30, bis
  50/60 fps dort am Geraet gemessen sind; 4K wird erst nach einer Messung
  gemeldet. Ueber 30 fps bekommen virtuelle Kamera und Programm-Vorschauen
  jedes zweite Programmbild (60 -> 30, 50 -> 25), die Aufnahme jedes; siehe
  [meeting-recording.md](./meeting-recording.md), Abschnitt 50 and 60 fps.
- `program_formats.keyer_max_fps` ist die hoechste Programm-Bildrate, bei der
  Keying laeuft: heute `30` auf jeder Plattform (eine Stelle:
  `BASE_MEETING_PROGRAM_FORMAT_LIMITS` in
  `services/meeting/meeting-capabilities.ts`). Es ist die einzige Quelle der
  Grenze; die Web-App rechnet nicht mit einer festen 30. Fehlt das Feld
  (aeltere Bridge), ist keine Grenze bekannt. 50 und 60 fps gibt es also nur
  ohne Keying. Die Bridge ist der Schiedsrichter:
  - "Keying aktiv" heisst `keyer.settings.enabled: true` im Helper. Es gibt
    keinen zweiten Schalter; Modell und Hintergrund schalten nichts ein. Ein
    frisch gestarteter Helper hat Keying aus.
  - `meeting_keyer_configure` mit `enabled: true`, waehrend das laufende
    Programm schneller ist als `keyer_max_fps`, wird abgelehnt:
    `errorCode: "meeting_keyer_fps_unsupported"` mit
    `data { program_fps, keyer_max_fps }`. Die Ablehnung kommt vor jeder
    Wirkung: der Helper wird nicht gefragt, nichts aus dem Patch wird
    uebernommen (auch der Hintergrund nicht), kein Status wird ausgeloest.
    Ein Patch mit `enabled: false` oder ohne `enabled` geht bei jeder
    Bildrate durch.
  - `meeting_engine_start` prueft die Grenze nicht, weil der Zustand
    "Keying aktiv bei mehr als `keyer_max_fps`" ueber diesen Weg nicht
    entstehen kann: bei laufender Engine mit anderer Bildrate kommt ohnehin
    `meeting_engine_restart_required`; ein Start, der einen Helper erzeugt,
    beginnt mit Keying aus, und die Bridge spielt bei einem solchen Start
    keine Keyer-Einstellung ein (`meeting_engine_stop` verwirft die gemerkte
    Einstellung). Wieder eingeschaltet wird Keying nur ueber
    `meeting_keyer_configure` (die Web-App schiebt ihre Einstellung nach dem
    Start nach) und damit durch die Pruefung oben.
  - Nur der Absturz-Neustart spielt die gemerkte Keyer-Einstellung selbst
    wieder ein, mit derselben Bildrate wie zuvor. Stammt sie von einer
    langsameren Engine (Nutzer-Start mit 50/60 fps waehrend einer laufenden
    Wiederherstellung, danach ein weiterer Absturz), wird sie mit
    `enabled: false` eingespielt und eine Warnung geloggt.
  - Die Bridge senkt die Bildrate nie selbst: das braucht einen
    Engine-Neustart (beendet Aufnahme, Kamera, virtuelle Kamera) und bleibt
    Sache der Web-App. Eine Stream-Deck-Taste, die Keying bei 50/60 fps
    einschaltet, wird deshalb abgelehnt: die Taste blinkt rot,
    `streamdeck_error` traegt `error_code: "meeting_keyer_fps_unsupported"`.
- `recording_probe` ist der Zustand der Encoder-Probe hinter `recording`:
  `pending` = noch kein Ergebnis (nicht gestartet, laeuft, oder ein
  voruebergehender Fehler mit verbleibenden Versuchen; spaetere `get_status`
  stossen die Wiederholung an, die Web-App fragt also weiter), `done` =
  Ergebnis liegt vor und `recording` steht (auch mit leerer Liste), `failed`
  = fuer diesen Bridge-Lauf ohne Ergebnis entschieden (Helper fehlt,
  unlesbare Ausgabe, Enumeration fehlgeschlagen oder dreimal voruebergehend
  gescheitert), `recording` fehlt bis zum Neustart der Bridge. Eine Plattform
  ohne Recorder meldet `done` mit leerer Liste, ohne zu proben. Das Feld
  fehlt auf Bridges vor diesem Stand; dort hiess ein fehlendes `recording`
  beides, "prueft noch" und "gescheitert".
- `recording.codecs` nennt die Codecs, die der Recorder schreiben kann **und**
  fuer die dieser Rechner einen Hardware-Encoder hat, je mit Container und der
  groessten Programmgroesse/Bildrate (`max_height` wie bei `program_formats`
  auf das Querformat bezogen). `codec` ist `MeetingRecordingCodecT`: `h264`,
  `hevc`, `prores_422_lt`, `prores_422`, `prores_422_hq`. Was der Recorder je
  Plattform schreibt, steht in `MEETING_RECORDER_SUPPORTED_CODECS`: unter macOS
  alle fuenf, unter Windows nur `h264` (dort nie ProRes). Ein Mac ohne
  ProRes-Hardware meldet also `h264` und `hevc`, Windows meldet `h264` auch
  mit HEVC-Hardware. `container` folgt aus dem Codec (`h264`/`hevc`: `mp4`,
  ProRes: `mov`; `MEETING_RECORDING_CODEC_FORMATS`). `max_height` ist der Wert
  aus `program_formats`; `max_fps` ist das Minimum aus der hoechsten Bildrate
  der Plattform und der Grenze des Codecs in `MEETING_RECORDER_CODEC_MAX_FPS`
  (macOS: 60 fuer jeden Codec, Windows: 30 fuer `h264`) und kann damit fuer
  einen einzelnen Codec unter `program_formats` liegen.
- Die Encoder-Liste kommt aus `meeting-helper --probe-recording`
  (`services/meeting/meeting-recording-probe.ts`): die Bridge startet den
  Helper dafuer als eigenen, kurzlebigen Prozess (keine Engine, kein Geraet),
  beim ersten `get_status`, mit 5 s Timeout. Ein Ergebnis gilt fuer den
  Bridge-Lauf. Scheitert die Probe endgueltig (Helper fehlt, unlesbare
  Ausgabe, Enumeration fehlgeschlagen), fehlt `recording` fuer diesen
  Bridge-Lauf. Scheitert sie voruebergehend (Timeout, Startfehler), fehlt
  `recording` zunaechst; spaetere `get_status` stossen im Hintergrund eine
  Wiederholung an (hoechstens drei Laeufe insgesamt), ohne darauf zu warten,
  und das Feld erscheint in der Statusabfrage nach dem geglueckten Lauf. Die
  Web-App darf ein fehlendes `recording` deshalb nicht fuer den ganzen
  Bridge-Lauf als endgueltig behandeln; `recording_probe` sagt, welcher Fall
  vorliegt (`pending` oder `failed`). Jeder gescheiterte Lauf schreibt eine
  Warnung mit dem Grund ins Log. `program_formats` haengt nicht an der Probe
  und wird immer gemeldet.
- Der lokale Status (`GET /video/status`) startet die Probe nie selbst; er
  meldet `recording_probe: "pending"` und traegt `recording` erst, nachdem ein
  `get_status` (oder die Codec-Pruefung eines Aufnahme-Starts) sie ausgefuehrt
  hat.
- `meeting_recording_start` und `meeting_recording_toggle` nehmen ein
  optionales `codec`. Ohne `codec` ist die Aufnahme `h264` in `mp4` wie bisher
  und wird nicht gegen die Faehigkeiten geprueft. Mit `codec` muss der Wert in
  `recording.codecs` stehen **und** das laufende Programm abdecken
  (`min(width, height) <= max_height`, `fps <= max_fps`), sonst kommt
  `errorCode: "meeting_recording_codec_unsupported"` mit
  `data { codec, reason }`, ohne dass der Helper gefragt wird. `reason`:
  `encoder_unavailable` (Probe fertig, Codec nicht in der Liste),
  `program_format_exceeded` (Codec da, deckt Groesse oder Bildrate des
  laufenden Programms nicht ab), `encoders_unknown` (Probe gescheitert oder
  auch nach dem Warten ohne Ergebnis). Ist die Probe noch nicht entschieden,
  wartet die Pruefung auf den laufenden Versuch (hoechstens 5 s). Die Aufnahme
  weicht nie auf einen anderen Codec aus; das gilt fuer jeden Ausloeser, auch
  die REC-Taste des Stream Decks, deren Belegung den eingestellten Codec
  traegt. Die Web-App sendet `codec` nur,
  wenn `recording_probe` gemeldet ist: das Start-Schema ist strikt, aeltere Bridges
  lehnen das unbekannte Feld ab. Die Endung von `file_path` muss zum Container
  des Codecs passen (`.mp4` bzw. `.mov`), sonst ist die Payload ungueltig.
  Ein Codec-Name, den die Bridge nicht kennt, ist keine ungueltige Payload,
  sondern ebenfalls `meeting_recording_codec_unsupported`.
  `meeting_recording_pick_path` bekommt dasselbe `codec` wie der Start und
  prueft es genauso, bevor der Dialog aufgeht.
- Fehlercodes eines abgelehnten Aufnahme-Starts (Start und Toggle):
  `meeting_recording_codec_unsupported` (Codec nicht gemeldet oder deckt das
  laufende Programm nicht ab, mit `data { codec, reason }`; oder der Helper
  hat keinen Hardware-Encoder dafuer; kein Software-Rueckfall, kein Ausweichen
  auf einen anderen Codec) und
  `recording_disk_space_low` mit `data { required_bytes, free_bytes }` (weniger
  frei als fuenf Minuten zur Datenrate des Codecs; ersetzt `disk_full` als
  Code, die Meldung `error` dieser Ablehnung bleibt `disk_full`, damit
  Web-Apps vor diesem Code weiter ihre Speicherplatz-Meldung zeigen). Die
  uebrigen Codes (`microphone_*`, `writer_create_failed`, `already_recording`,
  `invalid_arguments`) sind unveraendert. `already_recording` (Start, waehrend
  eine Aufnahme laeuft oder gerade startet) steht nur in der Antwort des
  abgelehnten Befehls: der Status der laufenden Aufnahme bleibt, wie er ist,
  `recording.last_error` wird davon nicht beschrieben (bis Nov 2026 blieb
  `already_recording` dort stehen, auch nachdem die Aufnahme sauber fertig
  war). Tabellen und Datenraten in
  [meeting-recording.md](./meeting-recording.md).
- `meeting_recording_stop` ist in der Bridge-Policy jetzt mit 35 s
  Relay-Timeout und 30 s lokaler SLA deklariert (vorher 12 s / 8 s), weil das
  Abschliessen der Datei bis zu 15 s dauern darf. Die Bridge selbst bricht
  keinen Befehl ab; wirksam wird das erst, wenn die Tabellen des
  Relay-Dienstes und der Web-App fuer `meeting_recording_stop` und
  `meeting_recording_toggle` nachziehen (siehe
  [meeting-recording.md](./meeting-recording.md), Abschnitt Finalize timeout).

#### `fallback_active` / `fallback_reason` / `model_hash_ok` auf macOS (B-11)

- `model_hash_ok` ist tri-state: `true`/`false` nur, wenn das aktive Backend die
  Modelldatei gegen den Manifest-Hash geprueft hat (Windows ONNX-/OpenVINO-MODNet).
  `null` = kein Hash-Check auf diesem Backend (CoreML-MODNet und Apple Vision auf
  macOS). Vor B-11 lieferte macOS hier immer `false`, was wie ein Hash-Mismatch
  aussah. Webapp-Typ `model_hash_ok?: boolean` muss zu `boolean | null` werden
  (Webapp-Follow-up); die Bridge mappt bereits `model_hash_ok ?? null`.
- CoreML->Vision-Downgrade sichtbar: Auf macOS ist der fused CoreML-MODNet-Keyer
  der Produktions-Keyer unabhaengig vom angeforderten `model` (die Webapp sendet
  kein `model`, der Default bleibt `vision_person_segmentation`). Faellt der fused
  CoreML-Keyer aus und uebernimmt der asynchrone Vision-Fallback, meldet der
  Status deshalb immer `fallback_active: true`, `keyer_degraded: true` und als
  `fallback_reason` den CoreML-Grund; `active_keyer` bleibt ehrlich
  `vision_person_segmentation`, `keyer_ready` bleibt `true` (Vision liefert Masken).
  Emittierte Gruende: die `fallback_reason` des CoreML-Keyers (`model_missing`,
  `model_compile_failed`, `model_load_failed`, `invalid_frame`,
  `frame_convert_failed`, `input_provider_failed`, `inference_failed`,
  `no_mask_output`, `coreml_requires_macos_13`, `coreml_unsupported_platform`,
  `not_loaded`) bzw. `coreml_inference_failed`, wenn CoreML ohne Grund eine leere
  Maske liefert. Sobald der fused Keyer wieder liefert, verschwindet der Fallback.
  Ist der fused Pfad per `BROADIFY_MEETING_GPU_PIPELINE=0` abgeschaltet, gibt es
  keinen fused Fehler und damit keinen Grund; Vision laeuft dann unmarkiert.

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
    "lastError": null, // string|null, required, camelCase, seit Bestand
    "program_format": null // object|null, null solange manager.state nicht "running" ist, seit Hochformat (ADR-0007)
  },
  "engine": null, // object|null, required, null wenn Helper nicht erreichbar
  "engineError": "connect ENOENT", // string, optional, camelCase, nur bei Statusfehler
  "recording": null, // object|null, required
  "call": { "active": false, "call_id": null }, // object, required
  "content_source": { "video": null, "browser": null }, // object, required in Stage 2
  "camera_permission_status": null, // string|null, required in Stage 2
  "program_format": null // object|null, wie manager.program_format, seit Hochformat (ADR-0007)
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
`elapsed_seconds`, `video_frames`, `audio_samples_written`,
`audio_samples_dropped`, `updated_at`, `captured_frames`, `program_dirty` und
`graphics_dirty`; zusaetzlich wird `keyer.status.metrics` aus der stabilen
Projektion entfernt.

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

`background_image_path` ist UTF-8; der Helper oeffnet die Datei ueber die
UTF-8-Pfadhelfer (auch bei Windows-Benutzernamen mit Umlaut) und meldet das
Ergebnis als Helper-Event in `meeting-helper-events.log`, nicht im
`meeting_status`: `background_image_loaded` einmal pro erfolgreichem Laden,
`background_image_load_failed` (`stage` `open`|`decode`, `errno`) genau
einmal pro Pfad, solange das Laden fehlschlaegt (Retry mit Backoff 400 ms *
2^n, max. 2 s). Das Feld `path` enthaelt dabei nur den Dateinamen
(Basename), nie das Verzeichnis - der volle Pfad liegt unter userData und
enthaelt den Windows-Benutzernamen. Details: `meeting-keyer-windows.md`, Abschnitt "Paths And
Encoding".

### Hintergrundbild nur mit Keying

Regel (Klicktest 2026-11-22): Bei Keying aus ist das Hintergrundbild nie im
Programm zu sehen, auch nicht fuer einzelne Bilder.

Das Hintergrundbild ist die unterste Ebene des Compositors. Bisher wurde es
immer gezeichnet; bei Keying aus verdeckte es nur die ungekeyte Kamera, die
das ganze Bild fuellt. Ohne Kamerabild (erste Bilder nach einem Engine-Start,
bevor die Kamera liefert; Kamerawechsel; Kamera-Ebene aus) war der Hintergrund
deshalb das ganze Programmbild, in Vorschau, virtueller Kamera und Aufnahme.
Die WebApp sendet die Auswahl mit jedem `keyer.configure`, auch mit
`enabled: false` (Engine-up-Reassert nach jedem Neustart); seit Keying in der
WebApp standardmaessig aus ist, ist das der Normalfall.

Jetzt entscheidet der Compositor an einer Stelle
(`selectVisibleBackgroundImage` in `compose/background_image_cache.h`,
genutzt vom GPU-Plan und vom CPU-Pfad ueber `visibleBackgroundImage`): bei
`keyerEnabled == false` wird kein Hintergrundbild gezeichnet. Unveraendert:

- `keyer.configure` speichert `background_image_path` weiter unabhaengig von
  `enabled`, und `keyer.get` meldet die Identitaet weiter zurueck. Keying
  einschalten zeigt den Hintergrund ohne neues Configure.
- Das Bild wird weiter beim ersten Composite nach dem Configure geladen, auch
  bei Keying aus (kein Decode im ersten gekeyten Bild).
  `background_image_loaded` heisst also "geladen", nicht "gezeigt".
- Keying aus und kein Kamerabild zeigt die Fuellflaeche (`background_mode`)
  statt des Hintergrundbilds.
- Die hintere Grafik-Flaeche (`bfy-meet-gfx-back`) wird bei Keying aus NICHT
  ausgeblendet. Sie traegt neben Hintergrund-Templates auch Inhalts-Templates
  und Folien (`resolveMeetingGraphicsPlane`), die ohne Keying sichtbar sein
  muessen (Folien ohne Kamera, Conference mit Kamera-PiP); der Helper kann die
  Ebenen dieser Flaeche nicht unterscheiden. Ob ein Hintergrund-TEMPLATE bei
  Keying aus zu sehen ist, entscheidet deshalb die WebApp: sie sendet die Ebene
  `meeting-background-template` im Meeting-Modus nur bei Keying an und entfernt
  sie beim Ausschalten (`docs/meeting/recording-format.md` der WebApp, "Ohne
  Keying kein Hintergrund"). Ein Client, der die Ebene bei Keying aus trotzdem
  sendet, bekommt sie gezeichnet.

Tests: `background_image_cache_test` (Auswahl bei Keying aus/an, Cache-Slot
bleibt unberuehrt) und, nur macOS, `compositor_background_render_test`: rendert
Programmbilder ohne Kamerabild ueber das produktive `renderProgramFrame` und
erwartet bei Keying aus genau die Fuellflaeche, bei Keying an das Bild. ctest
faehrt ihn zweimal, mit Metal (GPU-Plan) und als
`compositor_background_render_cpu_test` mit
`BROADIFY_MEETING_GPU_COMPOSITOR=0` (CPU-Pfad); auf einem Mac ohne Metal
laufen beide ueber den CPU-Pfad. Der D3D11-Pfad (Windows) teilt denselben
GPU-Plan, hat aber keinen eigenen Render-Test. Der Klicktest mit neu gebautem
Helper steht in der WebApp-Doku (Punkt 28).

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
