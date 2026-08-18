-- =============================================================
-- FULL DB RESET — publish-ready clean slate
-- Deletes ALL test data so the app starts completely fresh.
--   matches       -> all rows (211 cancelled + 4 completed test games)
--   match_history -> all rows (test VICTORY/DEFEAT/DRAW/ADMIN_FEE entries)
--   user_rewards  -> all rows (test balances — recreated automatically
--                    when users play; on-chain balance is the real source)
--   refund_queue  -> all rows (already empty, safety)
--   withdraw_requests, cheater_logs, system_alerts -> all rows (safety)
-- Keeps: tables + functions + RLS policies + triggers (schema intact).
-- =============================================================

begin;

-- 1. Refund queue first (FK -> matches)
delete from public.refund_queue;

-- 2. All matches (cancelled + completed test games)
delete from public.matches;

-- 3. All history ledger entries (VICTORY/DEFEAT/DRAW/ADMIN_FEE test entries)
delete from public.match_history;

-- 4. All reward balances (test data; app recreates rows on first play)
delete from public.user_rewards;

-- 5. Safety: other tables with test residue
delete from public.withdraw_requests;
delete from public.cheater_logs;
delete from public.system_alerts;

-- 6. Reset serial sequences so IDs start from 1 again (fresh start)
do $$
declare
  seq_name text;
begin
  foreach seq_name in array array[
    'match_history_id_seq',
    'user_rewards_id_seq'
  ] loop
    if exists (select 1 from pg_class where relname = seq_name) then
      execute format('alter sequence public.%I restart with 1', seq_name);
    end if;
  end loop;
end $$;

commit;

-- =============================================================
-- VERIFY (run after commit to confirm the wipe)
-- select count(*) from public.matches;          -- expect 0
-- select count(*) from public.match_history;    -- expect 0
-- select count(*) from public.user_rewards;     -- expect 0
-- select count(*) from public.refund_queue;     -- expect 0
-- =============================================================
