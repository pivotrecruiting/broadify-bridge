-- Performance and security hardening for relay_pending_commands.

create index if not exists relay_pending_commands_bridge_id_idx
on public.relay_pending_commands (bridge_id);

create index if not exists relay_pending_commands_bridge_sequence_idx
on public.relay_pending_commands (bridge_id, sequence);

create index if not exists relay_pending_commands_created_at_idx
on public.relay_pending_commands (created_at);

create index if not exists relay_pending_commands_disconnected_at_idx
on public.relay_pending_commands (disconnected_at)
where disconnected_at is not null;

create index if not exists relay_pending_commands_replayable_attempts_idx
on public.relay_pending_commands (bridge_id, replayable, replay_attempts);

alter table public.relay_pending_commands enable row level security;

drop policy if exists relay_pending_commands_service_role_all
on public.relay_pending_commands;

create policy relay_pending_commands_service_role_all
on public.relay_pending_commands
for all
to service_role
using (true)
with check (true);

revoke all on table public.relay_pending_commands from anon;
revoke all on table public.relay_pending_commands from authenticated;
grant all on table public.relay_pending_commands to service_role;
