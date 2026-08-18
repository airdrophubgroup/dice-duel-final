-- ============================================================
-- RUN THIS IN: Supabase Dashboard → SQL Editor → New Query → RUN
-- ============================================================
-- This creates the Agent Airdrophubgroup command console.
-- After running, the "Send failed: unknown" error will be fixed.
-- ============================================================

-- Table
create table if not exists public.agent_commands (
  id bigint generated always as identity primary key,
  command text not null,
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'done', 'failed')),
  reply text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

alter table public.agent_commands enable row level security;
revoke all on table public.agent_commands from anon, authenticated;
grant all on table public.agent_commands to service_role;

-- create_agent_command (owner only)
create or replace function public.create_agent_command(
  p_admin_wallet text,
  p_command text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := lower(trim(p_admin_wallet));
  v_id bigint;
begin
  if v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;
  if p_command is null or length(trim(p_command)) < 3 then
    return jsonb_build_object('success', false, 'error', 'command too short');
  end if;
  if length(p_command) > 5000 then
    return jsonb_build_object('success', false, 'error', 'command too long (max 5000 chars)');
  end if;
  insert into public.agent_commands (command) values (trim(p_command)) returning id into v_id;
  return jsonb_build_object('success', true, 'command_id', v_id);
end;
$$;
grant execute on function public.create_agent_command(text, text) to anon, authenticated;

-- get_agent_commands (owner only, newest first)
create or replace function public.get_agent_commands(p_admin_wallet text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := lower(trim(p_admin_wallet));
  v_rows jsonb;
begin
  if v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;
  select coalesce(jsonb_agg(row_to_jsonb order by created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select id, command, status, reply, created_at, started_at, completed_at
      from public.agent_commands
      order by created_at desc
      limit 50
    ) row_to_jsonb;
  return v_rows;
end;
$$;
grant execute on function public.get_agent_commands(text) to anon, authenticated;

-- agent_complete_command (mark done/failed + reply)
create or replace function public.agent_complete_command(
  p_admin_wallet text,
  p_command_id bigint,
  p_status text,
  p_reply text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := lower(trim(p_admin_wallet));
begin
  if v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;
  if p_status not in ('done', 'failed') then
    return jsonb_build_object('success', false, 'error', 'invalid status');
  end if;
  update public.agent_commands
     set status = p_status,
         reply = coalesce(p_reply, reply),
         completed_at = now()
   where id = p_command_id;
  if not found then
    return jsonb_build_object('success', false, 'error', 'command not found');
  end if;
  return jsonb_build_object('success', true);
end;
$$;
grant execute on function public.agent_complete_command(text, bigint, text, text) to anon, authenticated;

-- agent_start_command (mark in_progress)
create or replace function public.agent_start_command(
  p_admin_wallet text,
  p_command_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := lower(trim(p_admin_wallet));
begin
  if v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;
  update public.agent_commands
     set status = 'in_progress', started_at = now()
   where id = p_command_id and status = 'pending';
  if not found then
    return jsonb_build_object('success', false, 'error', 'not a pending command');
  end if;
  return jsonb_build_object('success', true);
end;
$$;
grant execute on function public.agent_start_command(text, bigint) to anon, authenticated;

-- DONE! After running, go to your app → Admin Panel → Agent Command Console → type and send.
