-- ============================================================
-- PRUNE USER HISTORY LEDGER — keep only the latest 10 per user
--
-- The match_history table records every VICTORY / DEFEAT / DRAW
-- for every player, plus ADMIN_FEE rows for the house wallet.
-- It grows FOREVER (unlike the matches table which is pruned by
-- prune_user_matches) — over months of play this becomes tens of
-- thousands of rows nobody ever reads (the history modal reads the
-- matches table directly, and the admin revenue panel reads only
-- ADMIN_FEE rows).
--
-- This function deletes a user's OWN non-ADMIN_FEE history rows
-- beyond their latest 10, so the ledger stays bounded while the
-- admin revenue ledger (ADMIN_FEE) is NEVER touched.
--
-- SAFETY:
--   * Only rows where wallet_address = the caller's wallet.
--   * Only action_type IN ('VICTORY','DEFEAT','DRAW') — never
--     ADMIN_FEE (the house revenue ledger is kept in full).
--   * The latest 10 rows per wallet are always kept.
-- ============================================================

create or replace function public.prune_user_history(p_wallet text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet text := lower(trim(p_wallet));
  v_deleted int;
begin
  if v_wallet = '' then
    return jsonb_build_object('success', false, 'error', 'empty wallet');
  end if;

  delete from public.match_history mh
  where mh.wallet_address = v_wallet
    and mh.action_type in ('VICTORY', 'DEFEAT', 'DRAW')
    and mh.id not in (
      select id from public.match_history
      where wallet_address = v_wallet
        and action_type in ('VICTORY', 'DEFEAT', 'DRAW')
      order by created_at desc
      limit 10
    );

  get diagnostics v_deleted = row_count;
  return jsonb_build_object('success', true, 'deleted', v_deleted);
end;
$$;

grant execute on function public.prune_user_history(text) to anon, authenticated;
