-- ============================================================
-- AGENT AIRDROPHUBGROUP — SUPPORT TICKETS + AUTO SECURITY MONITOR
--
-- 1) support_tickets : user -> agent chat verification -> ticket,
--    admin replies from the admin panel (reply shows the admin's
--    REAL Worldcoin username).
-- 2) system_alerts  : the auto-monitor agent writes bug/security
--    findings here; a pg_cron job runs run_health_checks() every
--    5 minutes with zero manual intervention.
--
-- ALL access is via security-definer RPCs (the mini-app only uses
-- the anon key, so plain table RLS cannot tell users apart).
-- ============================================================

create table if not exists public.support_tickets (
  id              bigint generated always as identity primary key,
  user_wallet     text not null,
  user_username   text,
  summary         text not null,
  verified        jsonb default '{}'::jsonb,
  status          text not null default 'open',   -- open | replied | closed
  admin_reply     text,
  admin_username  text,
  admin_reply_at  timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists public.system_alerts (
  id            bigint generated always as identity primary key,
  severity      text not null default 'info',    -- info | warning | critical
  category      text not null,                   -- refund | matchmaking | payment | security | integrity
  message       text not null,
  details       jsonb default '{}'::jsonb,
  status        text not null default 'open',    -- open | resolved
  dedupe_key    text unique,
  created_at    timestamptz not null default now()
);

alter table public.support_tickets enable row level security;
alter table public.system_alerts enable row level security;

-- ============ USER SIDE ============
create or replace function public.create_support_ticket(
  p_wallet text, p_username text, p_summary text, p_verified jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_id bigint;
begin
  if p_wallet is null or p_summary is null or length(trim(p_summary)) < 5 then
    return jsonb_build_object('success', false, 'error', 'invalid_input');
  end if;
  insert into public.support_tickets (user_wallet, user_username, summary, verified)
  values (lower(p_wallet), p_username, p_summary, coalesce(p_verified, '{}'::jsonb))
  returning id into v_id;
  return jsonb_build_object('success', true, 'ticket_id', v_id);
end; $$;

create or replace function public.get_my_tickets(p_wallet text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  return (
    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
    from (
      select id, summary, status, admin_reply, admin_username, admin_reply_at, created_at
      from public.support_tickets
      where user_wallet = lower(p_wallet)
    ) t
  );
end; $$;

-- ============ ADMIN SIDE (admin wallet only) ============
create or replace function public.admin_get_tickets(p_admin_wallet text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if lower(p_admin_wallet) <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
    from (
      select id, user_wallet, user_username, summary, verified, status,
             admin_reply, admin_username, admin_reply_at, created_at
      from public.support_tickets
      where status in ('open','replied')
    ) t
  );
end; $$;

create or replace function public.admin_reply_ticket(
  p_admin_wallet text, p_ticket_id bigint, p_reply text, p_admin_username text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if lower(p_admin_wallet) <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;
  if p_reply is null or length(trim(p_reply)) = 0 then
    return jsonb_build_object('success', false, 'error', 'empty_reply');
  end if;
  update public.support_tickets
  set admin_reply = p_reply,
      admin_username = coalesce(p_admin_username, 'Admin'),
      admin_reply_at = now(),
      status = 'replied'
  where id = p_ticket_id and status in ('open','replied');
  if not found then return jsonb_build_object('success', false, 'error', 'not_found'); end if;
  return jsonb_build_object('success', true);
end; $$;

-- ============ ADMIN ALERTS VIEW ============
create or replace function public.admin_get_alerts(p_admin_wallet text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if lower(p_admin_wallet) <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;
  return (
    select coalesce(jsonb_agg(row_to_json(t) order by t.created_at desc), '[]'::jsonb)
    from (
      select id, severity, category, message, details, status, created_at
      from public.system_alerts
      order by (severity = 'critical') desc, created_at desc
      limit 50
    ) t
  );
end; $$;

-- ============ AUTO MONITOR (agent) ============
create or replace function public.run_health_checks() returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_dedupe text;
  v_message text;
  v_details jsonb;
  r record;
begin
  -- 1) Refunds pending/processing older than 5 minutes (stuck refund)
  for r in
    select rq.match_id, rq.wallet_address, rq.status, rq.created_at,
           m.fee, m.status as match_status
    from public.refund_queue rq
    left join public.matches m on m.id = rq.match_id
    where rq.status in ('pending','processing')
      and rq.created_at < now() - interval '5 minutes'
  loop
    v_dedupe := 'stuck-refund-' || r.match_id;
    v_message := 'Refund stuck for ' || r.wallet_address::text || ' (fee ' || coalesce(r.fee,0) || ' WLD)';
    v_details := jsonb_build_object('match_id', r.match_id, 'status', r.status, 'queued_at', r.created_at, 'match_status', r.match_status);
    insert into public.system_alerts (severity, category, message, details, dedupe_key)
    values ('critical', 'refund', v_message, v_details, v_dedupe)
    on conflict (dedupe_key) do nothing;
  end loop;

  -- 2) Failed refunds (resolver marked failed)
  for r in
    select rq.match_id, rq.wallet_address, rq.error, rq.created_at
    from public.refund_queue rq
    where rq.status = 'failed'
  loop
    v_dedupe := 'failed-refund-' || r.match_id;
    v_message := 'Refund FAILED for ' || r.wallet_address::text || ' — needs operator action';
    v_details := jsonb_build_object('match_id', r.match_id, 'error', coalesce(r.error, 'unknown'));
    insert into public.system_alerts (severity, category, message, details, dedupe_key)
    values ('critical', 'refund', v_message, v_details, v_dedupe)
    on conflict (dedupe_key) do nothing;
  end loop;

  -- 3) Ghost / stale waiting matches older than 3 minutes (unpaid)
  for r in
    select id, p1_username, fee, created_at from public.matches
    where status = 'waiting' and created_at < now() - interval '3 minutes'
  loop
    v_dedupe := 'stale-waiting-' || r.id;
    v_message := 'Stale waiting match by ' || coalesce(r.p1_username, '?') || ' (fee ' || coalesce(r.fee,0) || ' WLD)';
    v_details := jsonb_build_object('match_id', r.id, 'created_at', r.created_at);
    insert into public.system_alerts (severity, category, message, details, dedupe_key)
    values ('warning', 'matchmaking', v_message, v_details, v_dedupe)
    on conflict (dedupe_key) do nothing;
  end loop;

  -- 4) Matches stuck in 'playing'/'matched' longer than 3 minutes
  for r in
    select id, p1_username, p2_username, start_time from public.matches
    where status in ('playing','matched')
      and start_time < now() - interval '3 minutes'
  loop
    v_dedupe := 'stuck-game-' || r.id;
    v_message := 'Game stuck in ' || r.status || ' (' || coalesce(r.p1_username,'?') || ' vs ' || coalesce(r.p2_username,'?') || ')';
    v_details := jsonb_build_object('match_id', r.id, 'started_at', r.start_time);
    insert into public.system_alerts (severity, category, message, details, dedupe_key)
    values ('warning', 'matchmaking', v_message, v_details, v_dedupe)
    on conflict (dedupe_key) do nothing;
  end loop;

  -- 5) Completed matches where a paid player never got TNV credited
  for r in
    select id, p1_address, p2_address, p1_paid, p2_paid, p1_tnv_credited, p2_tnv_credited, winner_address
    from public.matches
    where status = 'completed'
      and ((p1_paid and not coalesce(p1_tnv_credited, false))
        or (p2_paid and not coalesce(p2_tnv_credited, false)))
  loop
    v_dedupe := 'missing-tnv-' || r.id;
    v_message := 'Completed match with uncredited TNV (' || r.id::text || ')';
    v_details := jsonb_build_object('match_id', r.id, 'winner', r.winner_address);
    insert into public.system_alerts (severity, category, message, details, dedupe_key)
    values ('warning', 'integrity', v_message, v_details, v_dedupe)
    on conflict (dedupe_key) do nothing;
  end loop;

  -- 6) Cheater detections in last 10 minutes
  for r in
    select wallet_address, click_count, detected_at from public.cheater_logs
    where detected_at > now() - interval '10 minutes'
  loop
    v_dedupe := 'cheat-' || r.wallet_address || '-' || r.detected_at::text;
    v_message := 'Auto-clicker detected: ' || r.wallet_address::text || ' (' || r.click_count || ' rapid taps)';
    v_details := jsonb_build_object('wallet', r.wallet_address, 'click_count', r.click_count, 'detected_at', r.detected_at);
    insert into public.system_alerts (severity, category, message, details, dedupe_key)
    values ('warning', 'security', v_message, v_details, v_dedupe)
    on conflict (dedupe_key) do nothing;
  end loop;

  return jsonb_build_object('success', true, 'checked', '6 categories');
end; $$;

grant execute on function public.create_support_ticket(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.get_my_tickets(text) to anon, authenticated;
grant execute on function public.admin_get_tickets(text) to anon, authenticated;
grant execute on function public.admin_reply_ticket(text, bigint, text, text) to anon, authenticated;
grant execute on function public.admin_get_alerts(text) to anon, authenticated;
grant execute on function public.run_health_checks() to anon, authenticated;
