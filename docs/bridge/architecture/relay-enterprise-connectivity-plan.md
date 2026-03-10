# Relay Enterprise Connectivity Plan

## Goal

Build an enterprise-grade relay connection model that remains operational under packet loss, unstable last-mile networks, half-open TCP sockets, and short-lived internet interruptions.

The target is not "never disconnect". The target is:

- Fast fault detection
- Automatic recovery
- No duplicate command execution
- No silent state drift
- Full observability

## Principles

- Treat WebSocket as an unreliable transport over an unreliable network.
- Detect dead peers actively, not passively.
- Make reconnects resumable instead of starting from a blank session.
- Use at-least-once delivery with idempotent command handling.
- Separate transport liveness from command SLA timeouts.
- Preserve security boundaries: local renderer IPC, signed relay commands, bounded payloads.

## Phased Delivery

### Phase 1: Transport Hardening

- Add active WebSocket heartbeat on the bridge client.
- Add active WebSocket heartbeat on the relay server.
- Log close code, close reason, and liveness timestamps on both sides.
- Keep reconnect fast and jittered.
- Keep command timeouts moderate (`15-20s`) and independent from liveness detection.

### Phase 2: Session Hardening

- Introduce resumable bridge sessions.
- Add `session_id` and `last_processed_sequence` to bridge reconnect handshake.
- Track connection state per bridge session instead of only `bridgeId -> ws`.
- Rebind pending commands to a resumed session when safe.

### Phase 3: Delivery Hardening

- Add command sequencing.
- Add `command_received` acknowledgement before command execution.
- Make command execution idempotent by caching processed request IDs.
- Replay only safe pending commands after successful resume.

### Phase 4: State Recovery

- Force state re-sync after reconnect or resume rejection.
- Republish graphics, engine, and output status after reconnect.
- Restore web app subscriptions automatically after bridge reconnect.

### Phase 5: Operability

- Add structured disconnect classification.
- Add latency, reconnect, heartbeat, timeout, and replay metrics.
- Add alerting for abnormal reconnect and timeout patterns.
- Add chaos tests for packet loss, latency spikes, and half-open sockets.

## Implementation Scope

### In `broadify-bridge-v2`

- `apps/bridge/src/services/relay-client.ts`
  - Bridge-side heartbeat
  - Close diagnostics
  - Session metadata
  - Resume-aware reconnect
  - Idempotent request cache
- `apps/bridge/src/services/command-router.ts`
  - Retry and idempotency review for side-effecting commands
- `packages/protocol/*`
  - Shared protocol types and schemas for resume and acknowledgements
- `docs/bridge/*`
  - Ongoing implementation and rollout documentation

### In `broadify-relay`

- Relay-side heartbeat
- Session registry
- Pending command store (Supabase/Postgres primary + file write-through fallback)
- Resume handshake
- Replay policy
- Subscriber rehydration
- Reliability metrics endpoint (`/metrics`)
- Alert loop for timeout-rate anomalies

## Delivery Checklist

### P1: Immediate

- [x] Create and maintain this rollout plan document
- [x] Add bridge-side active heartbeat
- [x] Add bridge-side close code and reason logging
- [x] Add bridge-side tests for heartbeat timeout and pong recovery
- [x] Document new bridge-side relay behavior

### P2: Short Term

- [x] Add relay-side active heartbeat
- [x] Add relay-side close code and reason logging
- [x] Introduce protocol versioning in shared relay messages
- [x] Add `session_id` and `last_processed_sequence` to reconnect handshake
- [x] Add `command_received` acknowledgement

### P3: Medium Term

- [x] Add idempotent command dedupe cache on the bridge
- [x] Add resumable pending command lifecycle in the relay
- [x] Add replay of safe commands after resume
- [x] Add forced state re-sync after reconnect

### P4: Long Term

- [x] Move pending command state to a durable store (Supabase/Postgres primary + file fallback)
- [ ] Add reconnect and delivery SLO dashboards
- [x] Add alerting and failure-class analytics baseline
- [ ] Add network-chaos integration tests

## Phase Status

- [x] Phase 1: Transport hardening implemented
- [x] Phase 2: Session hardening baseline implemented
- [x] Phase 3: Delivery hardening implemented
- [x] Phase 4: State recovery implemented (`bridge_resync_required` + snapshot republish after auth/reconnect)
- [ ] Phase 5: Operability and SRE instrumentation pending completion (metrics + alerts baseline live)

## Acceptance Criteria

- Dead sockets are detected in under 60 seconds.
- Short-lived network interruptions do not require manual recovery.
- Duplicate command delivery does not create duplicate side effects.
- Relay and bridge state converge automatically after reconnect.
- Every disconnect can be classified from logs and metrics.
- Packet loss degrades latency first, not correctness.

## Current Execution Status

- [x] Roadmap and phased checklist documented
- [x] Bridge-side heartbeat and diagnostics implemented
- [x] Bridge-side tests implemented
- [x] Relay-side heartbeat and disconnect diagnostics implemented
- [x] Relay protocol extension implemented (`protocolVersion`, `sessionId`, `lastProcessedSequence`, `command_received`)
- [x] Phase 3 delivery hardening implemented (bridge dedupe, relay pending resume lifecycle, safe replay, forced re-sync event)
- [x] Phase 4 state recovery implemented (bridge snapshot republish + subscriber-side re-sync trigger)
- [x] Durable pending command store baseline implemented (Supabase/Postgres + file write-through fallback)
- [x] Reliability counters + Prometheus-style metrics endpoint implemented
- [x] Timeout-rate alert evaluator implemented
- [ ] Optional backend upgrade: Redis stream/persistent queue for multi-region active-active
- [ ] SLO dashboard rollout pending
