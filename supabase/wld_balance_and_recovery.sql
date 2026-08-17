-- ============================================================
-- wld_balance_and_recovery.sql
--
-- user_rewards.wld_balance was never updated: the app only read it as
-- a fallback, so it stayed stale/0 while the on-chain balance moved.
-- secure_update_wld_balance lets the app persist the real on-chain
-- balance (informational only — payouts happen on-chain via MiniKit,
-- never from this column), so both the UI fallback and the Supabase
-- table show the true balance.
-- ============================================================

create or replace function public.secure_update_wld_balance(p_wallet text, p_balance numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet text := lower(trim(p_wallet));
begin
  if p_balance is null or p_balance < 0 then
    return json_build_object('success', false, 'error', 'invalid_balance');
  end if;

  insert into user_rewards (wallet_address, tnv_balance, wld_balance, is_blocked)
  values (v_wallet, 0, p_balance, false)
  on conflict (wallet_address) do update
    set wld_balance = excluded.wld_balance;

  return json_build_object('success', true);
end;
$$;
