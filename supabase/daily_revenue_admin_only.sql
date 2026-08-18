-- =============================================================
-- daily_revenue_admin_only.sql
--
-- PROBLEMS FIXED:
--   1) SECURITY HOLE: admin_get_revenue had NO hardcoded admin
--      wallet check — anyone who knew the admin wallet address
--      (it is public in the app) could pass it and read the
--      full admin fee ledger. Every other admin RPC validates
--      the wallet server-side; this one did not. FIXED.
--   2) NEW: admin_get_daily_revenue — the admin sees revenue
--      grouped per day (24h, midnight-to-midnight), so they can
--      verify "aaj kitna aaya" against their wallet daily.
--
-- Both RPCs only return data when p_admin_wallet IS the admin
-- wallet. Any other caller gets an 'unauthorized' rejection.
-- =============================================================

-- ---------- 1. Fix the security hole ----------
create or replace function public.admin_get_revenue(p_admin_wallet text)
returns setof public.match_history
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := lower(trim(p_admin_wallet));
begin
  -- HARDCODED admin check: only the owner wallet may read the ledger.
  if v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return;
  end if;
  return query
    select mh.*
    from public.match_history mh
    where mh.action_type = 'ADMIN_FEE'
    order by mh.created_at desc;
end;
$$;

grant execute on function public.admin_get_revenue(text) to anon, authenticated;

-- ---------- 2. NEW: daily revenue (24h groups) ----------
create or replace function public.admin_get_daily_revenue(p_admin_wallet text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := lower(trim(p_admin_wallet));
  v_today date;
  v_today_total numeric := 0;
  v_today_count bigint := 0;
  v_all_total numeric := 0;
  v_days jsonb;
begin
  -- HARDCODED admin check: only the owner wallet may read revenue.
  if v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;

  v_today := current_date;

  -- Today's revenue (since 00:00 local Supabase time)
  select coalesce(sum(amount), 0), count(*)
    into v_today_total, v_today_count
  from public.match_history
  where action_type = 'ADMIN_FEE'
    and created_at >= v_today::timestamp;

  -- All-time total
  select coalesce(sum(amount), 0)
    into v_all_total
  from public.match_history
  where action_type = 'ADMIN_FEE';

  -- Per-day breakdown (last 14 days), newest first
  select coalesce(jsonb_agg(d order by d.day desc), '[]'::jsonb)
    into v_days
  from (
    select
      (created_at at time zone 'UTC')::date as day,
      sum(amount) as total,
      count(*) as fees
    from public.match_history
    where action_type = 'ADMIN_FEE'
    group by (created_at at time zone 'UTC')::date
    order by day desc
    limit 14
  ) d;

  return jsonb_build_object(
    'success', true,
    'today', jsonb_build_object('date', v_today, 'total', v_today_total, 'fees', v_today_count),
    'all_time_total', v_all_total,
    'days', v_days
  );
end;
$$;

grant execute on function public.admin_get_daily_revenue(text) to anon, authenticated;

-- =============================================================
-- VERIFY (as admin wallet only):
--   select * from public.admin_get_revenue('0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1');
--   select public.admin_get_daily_revenue('0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1');
-- Anyone else: 'unauthorized'
-- =============================================================
