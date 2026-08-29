-- ============================================================
-- CLEAN DATABASE — Remove all test data for fresh production
-- ============================================================
-- This script clears all test data from every table.
-- Run this BEFORE publishing to ensure new users see clean data.
-- ============================================================

-- 1. Clear test matches (all test game data)
DELETE FROM public.matches WHERE true;

-- 2. Clear test match history (all game logs + admin fees)
DELETE FROM public.match_history WHERE true;

-- 3. Clear test refund queue (all pending/done refunds)
DELETE FROM public.refund_queue WHERE true;

-- 4. Clear test user rewards (all TNV balances + game stats)
DELETE FROM public.user_rewards WHERE true;

-- 5. Clear test withdrawal requests
DELETE FROM public.withdraw_requests WHERE true;

-- 6. Clear test support tickets
DELETE FROM public.support_tickets WHERE true;

-- 7. Clear test agent commands
DELETE FROM public.agent_commands WHERE true;

-- 8. Clear test cheater logs
DELETE FROM public.cheater_logs WHERE true;

-- 9. Clear test security audit log
DELETE FROM public.security_audit_log WHERE true;

-- 10. Clear used transaction hashes (allows fresh payments)
DELETE FROM public.used_tx_hashes WHERE true;

-- 11. Clear system alerts
DELETE FROM public.system_alerts WHERE true;

-- ============================================================
-- VERIFY CLEAN STATE
-- ============================================================
SELECT 'matches' as tbl, count(*) as rows FROM public.matches
UNION ALL SELECT 'match_history', count(*) FROM public.match_history
UNION ALL SELECT 'refund_queue', count(*) FROM public.refund_queue
UNION ALL SELECT 'user_rewards', count(*) FROM public.user_rewards
UNION ALL SELECT 'withdraw_requests', count(*) FROM public.withdraw_requests
UNION ALL SELECT 'support_tickets', count(*) FROM public.support_tickets
UNION ALL SELECT 'agent_commands', count(*) FROM public.agent_commands
UNION ALL SELECT 'cheater_logs', count(*) FROM public.cheater_logs
UNION ALL SELECT 'security_audit_log', count(*) FROM public.security_audit_log
UNION ALL SELECT 'used_tx_hashes', count(*) FROM public.used_tx_hashes
UNION ALL SELECT 'system_alerts', count(*) FROM public.system_alerts;

-- All counts should be 0 after cleanup.
