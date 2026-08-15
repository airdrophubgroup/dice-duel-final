-- =============================================================
-- CLEANUP + SECURITY HARDENING (one-time, already applied live)
--  1. Delete legacy cron job that embeds a service_role JWT
--  2. Drop orphan tables (match_settle_queue, match_settlement_queue,
--     refund_requests)
--  3. Drop 16 orphan functions
--  4. Drop legacy matches columns that nothing reads/writes
--  5. Fix RLS: remove "allow everything for everyone" policies,
--     keep SELECT-only (+ match_history INSERT for app logging)
--  6. Delete stale test rows
-- =============================================================

-- 1. Legacy cron job containing a plaintext service_role JWT
select cron.unschedule('process-refunds-every-1-minute');

-- 2. Orphan tables (cascade drops the on_refund_request_inserted trigger)
drop table if exists public.match_settle_queue;
drop table if exists public.match_settlement_queue;
drop table if exists public.refund_requests cascade;

-- 3. Orphan functions (verified: not called by app.js, the resolver,
--    cron, or any other function)
drop function if exists public.admin_block_user;
drop function if exists public.auto_complete_match;
drop function if exists public.cancel_search;
drop function if exists public.check_and_process_match_timeout;
drop function if exists public.check_rapid_click;
drop function if exists public.complete_match_game;
drop function if exists public.confirm_player_payment;
drop function if exists public.get_expired_waiting_matches;
drop function if exists public.increment_tnv;
drop function if exists public.queue_match_settlement;
drop function if exists public.secure_cancel_and_refund;
drop function if exists public.secure_join_match;
drop function if exists public.settle_match_result;
drop function if exists public.trigger_refund_webhook;
drop function if exists public.update_user_wld_balance;
drop function if exists public.validate_player_move;

-- 4. Legacy matches columns (nothing references them)
alter table public.matches
  drop column if exists player_1,
  drop column if exists player_2,
  drop column if exists p1_ready,
  drop column if exists p2_ready,
  drop column if exists last_seen_p1,
  drop column if exists last_seen_p2,
  drop column if exists last_ping,
  drop column if exists settled;

-- 5. RLS: matches — SELECT only
drop policy if exists "Allow all on matches" on public.matches;
drop policy if exists "Allow all operations on matches for everyone" on public.matches;
drop policy if exists "Allow delete matches" on public.matches;
drop policy if exists "Allow public insert matches" on public.matches;
drop policy if exists "Allow public update matches" on public.matches;
drop policy if exists "Allow read matches" on public.matches;
drop policy if exists "Allow update matches" on public.matches;
drop policy if exists "Allow update on matches" on public.matches;
drop policy if exists "Allow update payment status" on public.matches;
drop policy if exists "select_all" on public.matches;

-- RLS: user_rewards — SELECT only (leaderboard + own balance)
drop policy if exists "Allow all operations on user_rewards for everyone" on public.user_rewards;
drop policy if exists "Allow update user rewards" on public.user_rewards;
drop policy if exists "Allow upsert user rewards" on public.user_rewards;
drop policy if exists "Allow users to view rewards" on public.user_rewards;
drop policy if exists "Block direct balance updates" on public.user_rewards;
drop policy if exists "select_all" on public.user_rewards;

-- RLS: withdraw_requests — SELECT only
drop policy if exists "Allow all operations on withdraw_requests for everyone" on public.withdraw_requests;
drop policy if exists "Allow update withdraw" on public.withdraw_requests;
drop policy if exists "Public insert withdraw" on public.withdraw_requests;
drop policy if exists "select_all" on public.withdraw_requests;

-- RLS: cheater_logs — SELECT only
drop policy if exists "Allow all operations on cheater_logs for everyone" on public.cheater_logs;

-- RLS: match_history — SELECT + INSERT (the app logs history directly)
drop policy if exists "Allow all access to match_history" on public.match_history;
drop policy if exists "Allow all operations on match_history for everyone" on public.match_history;
create policy "anon insert match_history" on public.match_history
  for insert to anon, authenticated with check (true);

-- RLS: refund_queue — NO public access (resolver uses the service key,
-- inserts go through the queue_refund_request RPC)
drop policy if exists "Enable insert for all users" on public.refund_queue;
drop policy if exists "Enable select for all users" on public.refund_queue;

-- 6. Stale test rows
delete from public.matches
 where status = 'cancelled' and p1_paid = false and p2_paid = false;
delete from public.withdraw_requests
 where wallet_address ilike '%DEV%' and status = 'pending';
