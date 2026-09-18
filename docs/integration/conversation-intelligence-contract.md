# Conversation Intelligence — Integration Contract (v0, draft)

Status: **v0 draft** — Stufe 1 (usage tracking + call detection) is implemented
bridge-side; the relay/cloud counterparts consume this contract. Breaking
changes bump the per-line `v` field, never mutate the meaning of an existing
version.

Consumers: `broadify-bridge` (producer), `broadify-relay` (broker), `broadify`
webapp/Supabase (ingest + UI).

## 1. Local usage event log (bridge-side JSONL)

The bridge appends one JSON object per line to
`<userDataDir>/intelligence/usage/usage-current.jsonl` (rotated at 5 MB, max 5
rotated files `usage-<ISO>.jsonl`). Producer:
`apps/bridge/src/services/intelligence/usage-event-recorder.ts`. The zod schema
in `apps/bridge/src/services/intelligence/intelligence-types.ts` is the single
source of truth; this section is documentation, not a second definition.

All timestamps are **bridge wall-clock epoch milliseconds** (`Date.now()`).
Graphics events and call markers share one clock, which is what makes the
transcript/graphics overlay possible later. Ingest must treat bridge time as
authoritative and only *add* a server `received_at`, never replace `at`.

Line shapes (discriminated on `type`, JSON keys `snake_case`):

| `type` | Fields | Meaning |
| --- | --- | --- |
| `graphic_shown` | `v`, `at`, `source`, `layer_id`, `category`, `preset_id?`, `report_preset_id?` | A layer became visible on plane `source` (`studio` \| `meeting-back` \| `meeting-front`). |
| `graphic_hidden` | `v`, `at`, `source`, `layer_id`, `reason` | The layer left the air. `reason` vocabulary: `remove_layer`, `preset_replace`, `preset_expired`, `manual`, `clear_all_layers`, `replaced`, `shutdown`. |
| `call_started` | `v`, `at`, `call_id` | Call detector rising edge (see §2). |
| `call_ended` | `v`, `at`, `call_id`, `reason` | `reason`: `clients_gone` \| `engine_stopped`. |

Guarantees and non-guarantees:

- `graphic_shown`/`graphic_hidden` pair up per (`source`, `layer_id`) in file
  order. Re-sending an identical layer (same `layer_id` + same
  `preset_id`/`report_preset_id`/`category`) is a **continuation** and emits
  nothing — repeated builder syncs do not inflate counts. A re-send with a
  different identity closes the old interval (`reason: "replaced"`) and opens a
  new one.
- A crash can leave an interval open (a `graphic_shown` without its
  `graphic_hidden`). Ingest must close orphans at the next `call_ended` /
  end-of-file and flag them, never error.
- Events are append-only and idempotent to re-process; dedupe key for ingest is
  (`call_id`, `at`, `type`, `layer_id`).
- Meeting-plane identity is only meaningful once the webapp sends
  `report_preset_id` (webapp PR #262). Until then meeting lines carry only
  `layer_id` (`meeting-session-<uuid>-preset-<category>`); ingest stores them
  but cannot join to a template.

## 2. Call detection (Stufe 1 semantics)

Signal: the meeting helper's VCam consumer count (`engine.vcam_clients`),
sampled by the 2 s status poll and nudged by the helper's
`meeting_vcam_raw client_connected/client_disconnected` stdout events.
State machine (`apps/bridge/src/services/intelligence/call-detector.ts`):
count > 0 sustained ≥ 5 s → `call_started` (fresh UUID `call_id`); count == 0
sustained ≥ 15 s → `call_ended(clients_gone)`. Engine/helper stop while a call
is active → `call_ended(engine_stopped)`. Short flaps inside the hysteresis
windows produce no events and keep the same `call_id`.

Exposure: `meeting_status` snapshots carry a stable top-level
`call: { active: boolean, call_id: string | null }` object. Both fields are
projection-stable, so every transition publishes immediately via
`projection_changed` — clients must not poll for this.

Known limitation (documented, accepted for v1): a call without the Broadify
camera selected is invisible; a Teams/Zoom device-preview can arm the detector
(the 5 s rising hysteresis filters most of it).

## 3. Relay broker messages (implemented: bridge + relay + RPCs)

WS message types, bridge → relay, authenticated by the existing Ed25519
bridge session (the relay matches `wsToBridgeId` exactly like
`bridge_event`). The relay is a **broker, never a data pipe**: payloads stay
< 1 KB; transcript/usage files never travel over the relay socket. Relay side
routes exclusively through service-role definer RPCs (webapp migration
`20260918100400_add_conversation_intelligence_relay_rpcs.sql`).

Requests (bridge → relay; all carry `bridgeId` + `callId` (UUID), timestamps
are bridge epoch ms):

| `type` | Extra fields | Relay behaviour |
| --- | --- | --- |
| `ci_call_start` | `startedAt`, `controlSessionId?` | Resolve org (`ci_resolve_bridge_org`), gate on org settings + entitlement (`ci_begin_call`), insert `meeting_calls` (id = callId, idempotent). |
| `ci_call_end` | `endedAt`, `reason` | `ci_end_call` (ownership-gated, only open calls). |
| `ci_upload_request` | `kind: "graphics" \| "transcript"` | `ci_register_upload` (server constructs the path), mint signed upload URL, return it. |
| `ci_upload_complete` | `kind` | HEAD-verify the object, `ci_complete_upload` → deduped ingest job. |

Response (relay → bridge): `ci_result { op, callId, success, accepted?,
reason?, uploadUrl?, storagePath?, error? }`. Stable error codes:
`invalid_call_id`, `bridge_not_linked`, `invalid_kind`, `internal_error`
(detail only in the relay log). Gate rejections come as `success: true,
accepted: false` with `reason` (`feature_disabled`, `bridge_not_linked`,
`call_id_conflict`); the bridge then drops the upload task — data stays
local.

Bridge-side sequencing (`ci-session-coordinator.ts`): every finished call
becomes one persistent queue task; the drain re-runs the FULL sequence
(start → end → upload_request → guarded PUT with `x-upsert` →
upload_complete) because every step is idempotent server-side. Uploaded
usage slice: events with `at` in `[started_at − 5 min, ended_at + 5 s]`,
call markers filtered to this `call_id`; intervals opened before the window
appear as orphan `graphic_hidden` and are synthesized from call start at
ingest (see §1).

Storage paths (server-constructed, the bridge never chooses paths):
`orgs/{orgId}/calls/{callId}/graphics.jsonl` and `…/transcript.jsonl` in the
private `call-transcripts` bucket.

## 4. Transcript JSONL (Stufe 2 — reserved)

One segment per line:
`{ v: 1, seq, speaker: "self" | "other", started_ms, ended_ms, text }` with
`*_ms` relative to `recording_started_at_epoch_ms` (carried in the recording
status and in the upload manifest). Speaker attribution is by construction:
`self` = microphone sidecar, `other` = system-audio sidecar.
