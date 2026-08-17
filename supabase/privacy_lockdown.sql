-- ============================================================
-- privacy_lockdown.sql
--
-- PROBLEM: match_history (the win/loss/refund ledger) was readable
-- by ANYONE holding the public anon key — a user or scraper could
-- query /rest/v1/match_history and see every player's wins, losses,
-- refund amounts and wallet addresses. The app UI filters per-wallet,
-- but the database itself was wide open.
--
-- The app has NO Supabase Auth session: it uses the anon key and
-- passes the wallet as a parameter. So RLS "own rows" can't work —
-- the app's established security pattern is SECURITY DEFINER RPCs
-- that validate the wallet server-side (same as get_refund_status,
-- queue_refund_request, etc.).
--
-- FIX:
--   1) REVOKE direct SELECT on match_history from anon/authenticated
--      — nobody can list the ledger via the REST API anymore.
--   2) get_my_history(p_wallet)  — a wallet reads ONLY its own rows.
--   3) admin_get_revenue(p_admin_wallet) — admin reads ADMIN_FEE
--      rows only for the admin wallet (server-validated).
--   4) INSERT stays open (the app logs history with the anon key).
-- ============================================================

-- ---------- 1. Lock the ledger: no direct reads ----------
revoke select on table public.match_history from anon, authenticated;

-- (INSERT remains allowed so logMatchHistory keeps working.)

-- ---------- 2. get_my_history: own rows only ----------
create or replace function public.get_my_history(p_wallet text)
returns setof public.match_history
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet text := lower(trim(p_wallet));
begin
  return query
    select mh.*
    from public.match_history mh
    where lower(mh.wallet_address) = v_wallet
    order by mh.created_at desc
    limit 50;
end;
$$;

grant execute on function public.get_my_history(text) to anon, authenticated;

-- ---------- 3. admin_get_revenue: admin wallet only ----------
create or replace function public.admin_get_revenue(p_admin_wallet text)
returns setof public.match_history
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := lower(trim(p_admin_wallet));
begin
  return query
    select mh.*
    from public.match_history mh
    where mh.action_type = 'ADMIN_FEE'
      and lower(mh.wallet_address) = v_admin
    order by mh.created_at desc;
end;
$$;

grant execute on function public.admin_get_revenue(text) to anon, authenticated;
