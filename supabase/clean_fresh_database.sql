-- ============================================================
-- CLEAN FRESH DATABASE SQL
-- Run this ONCE to get a clean database ready for production.
-- This removes all test data and creates proper tables/functions.
-- ============================================================

-- ============================================================
-- STEP 1: CLEAN ALL TEST DATA
-- ============================================================

-- Clean matches (test data)
DELETE FROM public.matches WHERE status IN ('waiting', 'searching', 'matched', 'playing');
-- Keep completed matches for history but clean old ones
DELETE FROM public.matches WHERE created_at < now() - interval '30 days' AND status = 'completed';

-- Clean refund queue (test entries)
DELETE FROM public.refund_queue WHERE status IN ('pending', 'processing') AND created_at < now() - interval '7 days';

-- Clean user rewards (test balances)
-- DON'T DELETE — these are real user balances. Only clean if you want fresh start:
-- DELETE FROM public.user_rewards;

-- Clean match history (test entries)
DELETE FROM public.match_history WHERE created_at < now() - interval '30 days';

-- Clean support tickets (test entries)
DELETE FROM public.support_tickets WHERE created_at < now() - interval '30 days';

-- Clean agent commands (test entries)
DELETE FROM public.agent_commands WHERE created_at < now() - interval '30 days';

-- Clean cheater logs (test entries)
DELETE FROM public.cheater_logs WHERE created_at < now() - interval '30 days';

-- Clean used tx hashes (test entries)
DELETE FROM public.used_tx_hashes WHERE used_at < now() - interval '30 days';

-- ============================================================
-- STEP 2: VERIFY TABLES EXIST
-- ============================================================

-- matches table
CREATE TABLE IF NOT EXISTS public.matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id text,
  p1_address text,
  p1_username text,
  p2_address text,
  p2_username text,
  fee numeric DEFAULT 0.5,
  status text DEFAULT 'waiting',
  p1_paid boolean DEFAULT false,
  p2_paid boolean DEFAULT false,
  p1_payment_tx_hash text,
  p2_payment_tx_hash text,
  p1_score int DEFAULT 0,
  p2_score int DEFAULT 0,
  p1_taps_used int DEFAULT 0,
  p2_taps_used int DEFAULT 0,
  p1_last_roll_at timestamptz,
  p2_last_roll_at timestamptz,
  p1_tnv_credited boolean DEFAULT false,
  p2_tnv_credited boolean DEFAULT false,
  winner_address text,
  winner_username text,
  payout_amount numeric,
  tie boolean DEFAULT false,
  game_started boolean DEFAULT false,
  start_time timestamptz,
  settled_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- user_rewards table
CREATE TABLE IF NOT EXISTS public.user_rewards (
  wallet_address text PRIMARY KEY,
  tnv_balance int DEFAULT 0,
  wld_balance numeric DEFAULT 0,
  total_games int DEFAULT 0,
  games_played int DEFAULT 0,
  games_won int DEFAULT 0,
  is_blocked boolean DEFAULT false,
  last_refund_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- refund_queue table
CREATE TABLE IF NOT EXISTS public.refund_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid REFERENCES public.matches(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  fee numeric NOT NULL DEFAULT 0,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  tx_hash text,
  error text,
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz
);

-- match_history table
CREATE TABLE IF NOT EXISTS public.match_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  action_type text NOT NULL,
  amount numeric,
  description text,
  created_at timestamptz DEFAULT now()
);

-- withdraw_requests table
CREATE TABLE IF NOT EXISTS public.withdraw_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  tx_hash text,
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz
);

-- support_tickets table
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_wallet text NOT NULL,
  user_username text,
  summary text,
  status text DEFAULT 'pending',
  admin_reply text,
  admin_username text,
  admin_reply_at timestamptz,
  verified jsonb,
  created_at timestamptz DEFAULT now()
);

-- agent_commands table
CREATE TABLE IF NOT EXISTS public.agent_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_wallet text NOT NULL,
  command text NOT NULL,
  reply text,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now(),
  replied_at timestamptz
);

-- cheater_logs table
CREATE TABLE IF NOT EXISTS public.cheater_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  click_count int DEFAULT 0,
  detected_at timestamptz DEFAULT now()
);

-- used_tx_hashes table
CREATE TABLE IF NOT EXISTS public.used_tx_hashes (
  tx_hash text PRIMARY KEY,
  match_id uuid REFERENCES public.matches(id),
  player_address text,
  fee numeric,
  used_at timestamptz DEFAULT now()
);

-- system_alerts table
CREATE TABLE IF NOT EXISTS public.system_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity text DEFAULT 'info',
  category text,
  message text,
  details jsonb,
  status text DEFAULT 'open',
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- STEP 3: CREATE INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_matches_status ON public.matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_p1 ON public.matches(p1_address);
CREATE INDEX IF NOT EXISTS idx_matches_p2 ON public.matches(p2_address);
CREATE INDEX IF NOT EXISTS idx_matches_created ON public.matches(created_at);
CREATE INDEX IF NOT EXISTS idx_refund_queue_status ON public.refund_queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_user_rewards_wallet ON public.user_rewards(wallet_address);
CREATE INDEX IF NOT EXISTS idx_match_history_wallet ON public.match_history(wallet_address);
CREATE INDEX IF NOT EXISTS idx_withdraw_requests_wallet ON public.withdraw_requests(wallet_address);
CREATE INDEX IF NOT EXISTS idx_used_tx_hash_match ON public.used_tx_hashes(match_id);

-- ============================================================
-- STEP 4: ENABLE RLS
-- ============================================================

ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refund_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withdraw_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cheater_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.used_tx_hashes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_alerts ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- STEP 5: GRANT PERMISSIONS
-- ============================================================

-- Grant SELECT on public tables
GRANT SELECT ON public.matches TO anon;
GRANT SELECT ON public.user_rewards TO anon;
GRANT SELECT ON public.match_history TO anon;
GRANT SELECT ON public.withdraw_requests TO anon;
GRANT SELECT ON public.support_tickets TO anon;

-- Revoke direct writes (all writes go through RPCs)
REVOKE ALL ON public.matches FROM anon;
REVOKE ALL ON public.refund_queue FROM anon;
REVOKE ALL ON public.withdraw_requests FROM anon;
REVOKE ALL ON public.cheater_logs FROM anon;
REVOKE ALL ON public.agent_commands FROM anon;
REVOKE ALL ON public.used_tx_hashes FROM anon;

-- Re-grant SELECT after revoke
GRANT SELECT ON public.matches TO anon;

-- ============================================================
-- STEP 6: VERIFY CLEAN STATE
-- ============================================================

SELECT 'matches' as tbl, count(*) as rows FROM public.matches
UNION ALL
SELECT 'user_rewards', count(*) FROM public.user_rewards
UNION ALL
SELECT 'refund_queue', count(*) FROM public.refund_queue
UNION ALL
SELECT 'match_history', count(*) FROM public.match_history
UNION ALL
SELECT 'withdraw_requests', count(*) FROM public.withdraw_requests
UNION ALL
SELECT 'support_tickets', count(*) FROM public.support_tickets
UNION ALL
SELECT 'agent_commands', count(*) FROM public.agent_commands
UNION ALL
SELECT 'cheater_logs', count(*) FROM public.cheater_logs
UNION ALL
SELECT 'used_tx_hashes', count(*) FROM public.used_tx_hashes;

-- Should show mostly 0s or very low counts (only real data remains)
