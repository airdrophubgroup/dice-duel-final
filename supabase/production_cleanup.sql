-- ============================================================
-- PRODUCTION CLEANUP SCRIPT
-- Run this in Supabase Dashboard → SQL Editor before publishing
-- Clears all test data so fresh users see clean state
-- ============================================================

-- 1. Clean matches table (test matches from development)
DELETE FROM matches WHERE created_at < '2026-09-01'::date;

-- 2. Clean match_history (if accessible)
DELETE FROM match_history WHERE created_at < '2026-09-01'::date;

-- 3. Clean refund_queue (test refunds)
DELETE FROM refund_queue WHERE created_at < '2026-09-01'::date;

-- 4. Reset user_rewards to zero for test wallets
-- (keeps the table structure, just zeros out balances)
UPDATE user_rewards SET 
  tnv_balance = 0, 
  wld_balance = 0 
WHERE wallet_address LIKE '0x000000%'  -- test wallets start with 0x000000
   OR wallet_address LIKE '0x%000000000000000000000000000000%'; -- padded test addresses

-- 5. Clean withdraw_requests (test withdrawal requests)
DELETE FROM withdraw_requests WHERE created_at < '2026-09-01'::date;

-- 6. Clean cheater_logs
DELETE FROM cheater_logs WHERE created_at < '2026-09-01'::date;

-- 7. Clean support_tickets
DELETE FROM support_tickets WHERE created_at < '2026-09-01'::date;

-- 8. Clean agent_commands
DELETE FROM agent_commands WHERE created_at < '2026-09-01'::date;

-- 9. Verify clean state
SELECT 'matches' as tbl, count(*) as remaining FROM matches
UNION ALL
SELECT 'match_history', count(*) FROM match_history
UNION ALL
SELECT 'refund_queue', count(*) FROM refund_queue
UNION ALL
SELECT 'user_rewards', count(*) FROM user_rewards
UNION ALL
SELECT 'withdraw_requests', count(*) FROM withdraw_requests
UNION ALL
SELECT 'cheater_logs', count(*) FROM cheater_logs
UNION ALL
SELECT 'support_tickets', count(*) FROM support_tickets
UNION ALL
SELECT 'agent_commands', count(*) FROM agent_commands;
