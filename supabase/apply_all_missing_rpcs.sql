-- ============================================================
-- APPLY ALL MISSING RPCs — Run in Supabase Dashboard → SQL Editor
-- ============================================================
-- This file creates/updates every RPC that your app needs.
-- Safe to re-run: uses CREATE OR REPLACE / IF NOT EXISTS.
-- Run this ONCE and ALL features will work.
-- ============================================================

-- ============ 1. AGENT COMMANDS ============
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

create or replace function public.create_agent_command(p_admin_wallet text, p_command text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_admin text := lower(trim(p_admin_wallet)); v_id bigint;
begin
  if v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;
  if p_command is null or length(trim(p_command)) < 3 then
    return jsonb_build_object('success', false, 'error', 'command too short');
  end if;
  if length(p_command) > 5000 then
    return jsonb_build_object('success', false, 'error', 'command too long');
  end if;
  insert into public.agent_commands (command) values (trim(p_command)) returning id into v_id;
  return jsonb_build_object('success', true, 'command_id', v_id);
end; $$;
grant execute on function public.create_agent_command(text, text) to anon, authenticated;

create or replace function public.get_agent_commands(p_admin_wallet text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_admin text := lower(trim(p_admin_wallet)); v_rows jsonb;
begin
  if v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;
  select coalesce(jsonb_agg(row_to_jsonb order by created_at desc), '[]'::jsonb) into v_rows
    from (select id, command, status, reply, created_at, started_at, completed_at
      from public.agent_commands order by created_at desc limit 50) row_to_jsonb;
  return v_rows;
end; $$;
grant execute on function public.get_agent_commands(text) to anon, authenticated;

create or replace function public.agent_complete_command(p_admin_wallet text, p_command_id bigint, p_status text, p_reply text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_admin text := lower(trim(p_admin_wallet));
begin
  if v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;
  if p_status not in ('done', 'failed') then
    return jsonb_build_object('success', false, 'error', 'invalid status');
  end if;
  update public.agent_commands set status = p_status, reply = coalesce(p_reply, reply), completed_at = now()
   where id = p_command_id;
  if not found then return jsonb_build_object('success', false, 'error', 'command not found'); end if;
  return jsonb_build_object('success', true);
end; $$;
grant execute on function public.agent_complete_command(text, bigint, text, text) to anon, authenticated;

create or replace function public.agent_start_command(p_admin_wallet text, p_command_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_admin text := lower(trim(p_admin_wallet));
begin
  if v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;
  update public.agent_commands set status = 'in_progress', started_at = now()
   where id = p_command_id and status = 'pending';
  if not found then return jsonb_build_object('success', false, 'error', 'not a pending command'); end if;
  return jsonb_build_object('success', true);
end; $$;
grant execute on function public.agent_start_command(text, bigint) to anon, authenticated;


-- ============ 2. PRUNE USER HISTORY ============
-- Deletes match_history ledger rows beyond the latest 10 per user.
-- ADMIN_FEE rows are NEVER deleted (admin revenue ledger).
create or replace function public.prune_user_history(p_wallet text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_wallet text := lower(trim(p_wallet));
  v_count integer;
begin
  with ranked as (
    select id, row_number() over (order by created_at desc) as rn
    from public.match_history
    where wallet_address = v_wallet and action_type <> 'ADMIN_FEE'
  )
  delete from public.match_history where id in (select id from ranked where rn > 10);
  get diagnostics v_count = row_count;
  return jsonb_build_object('success', true, 'deleted', v_count);
end; $$;
grant execute on function public.prune_user_history(text) to anon, authenticated;


-- ============ 3. DAILY REVENUE (Admin only) ============
create or replace function public.admin_get_daily_revenue(p_admin_wallet text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_admin text := lower(trim(p_admin_wallet));
  v_days jsonb;
  v_total numeric := 0;
begin
  if v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;

  select coalesce(jsonb_agg(day_row order by day_row->>'day' desc), '[]'::jsonb) into v_days
  from (
    select jsonb_build_object(
      'day', to_char(created_at, 'YYYY-MM-DD'),
      'total', sum(amount),
      'fees', count(*)
    ) as day_row
    from public.match_history
    where wallet_address = v_admin and action_type = 'ADMIN_FEE'
    group by to_char(created_at, 'YYYY-MM-DD')
  ) sub;

  select coalesce(sum(amount), 0) into v_total
    from public.match_history
    where wallet_address = v_admin and action_type = 'ADMIN_FEE';

  return jsonb_build_object(
    'success', true,
    'days', v_days,
    'all_time_total', v_total,
    'today', jsonb_build_object('date', to_char(now(), 'YYYY-MM-DD'))
  );
end; $$;
grant execute on function public.admin_get_daily_revenue(text) to anon, authenticated;


-- ============ 4. CRON: Refund Resolver (every minute) ============
-- First enable extensions (safe to re-run)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove old cron job if it exists
do $$ begin
  perform cron.unschedule('refund-resolver-every-minute');
exception when others then null;
end $$;

-- Schedule refund-resolver every minute
-- IMPORTANT: The x-cron-secret MUST match your CRON_SECRET env var
-- set in: Dashboard → Edge Functions → refund-resolver → Secrets
-- If you never set one, use this same string in both places.
select cron.schedule(
  'refund-resolver-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://efmkazyrxllcyvcwmewd.supabase.co/functions/v1/refund-resolver',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "dice-duel-cron-2026"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);


-- ============================================================
-- ALL DONE! After running this, ALL features will work:
--   Agent Command Console, Auto Refunds, Daily Revenue, History Pruning
-- ============================================================
