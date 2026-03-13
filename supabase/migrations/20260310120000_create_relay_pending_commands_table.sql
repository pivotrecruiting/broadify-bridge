-- Durable relay pending command store.
-- This table persists in-flight relay commands to survive relay restarts
-- and support replay/resync flows.

create table if not exists public.relay_pending_commands (
  request_id text primary key,
  bridge_id text not null,
  command text not null,
  sequence bigint not null,
  route_mode text not null,
  replayable boolean not null default false,
  replay_attempts integer not null default 0,
  last_sent_at bigint not null,
  disconnected_at bigint,
  created_at bigint not null,
  received_at bigint,
  message jsonb not null,
  inserted_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint relay_pending_commands_sequence_check check (sequence > 0),
  constraint relay_pending_commands_route_mode_check check (
    route_mode in ('authenticated', 'pairing_only')
  ),
  constraint relay_pending_commands_replay_attempts_check check (replay_attempts >= 0),
  constraint relay_pending_commands_last_sent_at_check check (last_sent_at >= 0),
  constraint relay_pending_commands_disconnected_at_check check (
    disconnected_at is null or disconnected_at >= 0
  ),
  constraint relay_pending_commands_created_at_check check (created_at >= 0),
  constraint relay_pending_commands_received_at_check check (
    received_at is null or received_at >= 0
  ),
  constraint relay_pending_commands_message_is_object_check check (
    jsonb_typeof(message) = 'object'
  )
);

comment on table public.relay_pending_commands is
  'Durable relay pending command records for reconnect replay and resync orchestration.';

comment on column public.relay_pending_commands.request_id is
  'Relay request identifier (UUID string) used for idempotency and response correlation.';
comment on column public.relay_pending_commands.bridge_id is
  'Logical bridge identifier.';
comment on column public.relay_pending_commands.sequence is
  'Monotonic relay command sequence per bridge.';
comment on column public.relay_pending_commands.route_mode is
  'Routing mode used for dispatch: authenticated or pairing_only.';
comment on column public.relay_pending_commands.message is
  'Signed command envelope as sent to bridge.';

create or replace function public.set_relay_pending_commands_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_relay_pending_commands_updated_at
on public.relay_pending_commands;

create trigger trg_relay_pending_commands_updated_at
before update on public.relay_pending_commands
for each row
execute function public.set_relay_pending_commands_updated_at();
