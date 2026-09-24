# Engine Connection Lifecycle

## ATEM IP: library self-heal → status connecting → connected

The ATEM IP adapter lets the `atem-connection` library handle short network
outages on an already connected switcher. When the library emits
`disconnected` after a working connection, Bridge reports the engine as
`connecting` and keeps the current macro list instead of clearing it.

When the same library instance emits `connected` again, Bridge reports
`connected`, clears the transient error fields, and refreshes macros from the
current ATEM state. This keeps relay commands and UI state aligned with the
switcher after the library has recovered its socket.

The initial connect attempt still fails on real `Error` instances and on the
configured connect timeout. Library-internal string error events during the
connect phase are treated as parser/runtime noise and do not reject the connect
promise; once connected, runtime error events continue to update the engine
error message without forcing a disconnect.

Disconnect and failed connect cleanup destroy the ATEM library instance so the
threaded worker and UDP socket are released.

## ATEM USB helper liveness

The USB adapter feature-detects the native helper protocol from the `ready`
event. Helpers without `protocol_version` are treated as v1 and keep the legacy
fire-and-forget macro path so old release assets remain compatible.

Protocol v2 starts a heartbeat after `connected`: the bridge writes
`{"command":"ping","seq":N}` every 5 seconds and expects `pong`. Two missed
pongs mark the adapter `disconnected` and stop the helper; the supervisor then
owns reconnect. Protocol v2 macro runs include `req` and complete the adapter
promise only after helper `ack`; `nack` and 2 second ack timeouts fail the
macro execution with a protocol error.

Connect diagnostics preserve the helper HRESULT and SDK fail reason. A busy
USB switcher, for example when ATEM Software Control owns it, is mapped to
`DEVICE_BUSY` / HTTP 409 instead of the generic no-switcher path.

## Bridge supervisor

`EngineAdapterService` owns an `EngineConnectionSupervisor` around the current
adapter. The supervisor keeps the operator's desired config in memory while the
session is active and only reconnects when that desired config still exists and
shutdown has not begun.

State machine:
- `connected -> disconnected|error`: unsolicited drop. Bridge closes the old
  adapter first, creates a fresh adapter, then reconnects with exponential
  backoff.
- `connected -> connecting`: passive self-heal window. ATEM IP can recover
  inside the underlying library; Bridge waits `SELF_HEAL_GRACE_MS` (30 s).
- `connected -> connecting -> connected`: self-heal succeeded; Bridge clears
  reconnect metadata.
- `connected -> connecting` for more than 30 s: Bridge takes over, closes the
  old adapter, and enters the session reconnect loop.
- `disconnected -> disconnected`: ignored, so duplicate USB drop events do not
  arm duplicate retries.

Constants:
- Startup auto-connect delay: 3 s.
- Startup attempts: 5 total attempts, then quiet give-up.
- Session reconnect: 1 s base, exponential, capped at 30 s, with 20% jitter.
- Self-heal grace: 30 s.

Join semantics:
- Manual while manual connect with different config is in flight:
  `ALREADY_CONNECTING`.
- Manual while startup/auto connect with the same config is in flight: joins the
  in-flight attempt.
- Manual while startup/auto connect with a different config is in flight:
  cancels the auto attempt and starts the manual config.
- Manual disconnect cancels pending startup, self-heal, and reconnect timers.

`engine_status` includes additive `reconnect` metadata while retries are armed:
`attempt`, `nextRetryAt`, and optional `lastError`. Auto-reconnect failures stay
on `connecting` plus `reconnect.lastError`; they do not emit `engine_error`.

The same supervisor also observes vMix adapter drops. vMix polling failures that
move the adapter to `error` are therefore auto-reconnected through the same
fresh-adapter path.
