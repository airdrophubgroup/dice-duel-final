-- ============================================================
-- AI AGENT: ERROR LOGGING TABLE & RPC
-- ============================================================
-- This table stores all app errors detected by the AI Agent
-- (JS errors, network failures, RPC failures, auto-recovery actions).
-- Only admin can read errors; inserts are done via SECURITY DEFINER RPC.
-- ============================================================

-- 1. Create the app_errors table
CREATE TABLE IF NOT EXISTS public.app_errors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT now(),
  category TEXT DEFAULT 'unknown',
  message TEXT DEFAULT '',
  stack TEXT DEFAULT '',
  url TEXT DEFAULT '',
  wallet TEXT DEFAULT '',
  severity TEXT DEFAULT 'info',
  metadata JSONB DEFAULT '{}',
  auto_fixed BOOLEAN DEFAULT false,
  user_agent TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. RLS: Only admin can read; inserts via RPC
ALTER TABLE public.app_errors ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Admin can read app_errors" ON public.app_errors;
DROP POLICY IF EXISTS "Service role can insert app_errors" ON public.app_errors;

-- Admin can read all errors
CREATE POLICY "Admin can read app_errors"
  ON public.app_errors
  FOR SELECT
  USING (
    lower(wallet) = lower('0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1')
    OR lower((SELECT value FROM pg_catalog.pg_settings WHERE name = 'app.settings.admin_wallet')::text) = lower('0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1')
  );

-- Allow inserts from the anon key (client-side logging)
CREATE POLICY "Allow insert app_errors"
  ON public.app_errors
  FOR INSERT
  WITH CHECK (true);

-- 3. Create the log_app_error RPC (batch insert)
CREATE OR REPLACE FUNCTION public.log_app_error(p_errors JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
  v_item JSONB;
BEGIN
  -- Iterate through the JSONB array and insert each error
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_errors)
  LOOP
    INSERT INTO public.app_errors (
      timestamp, category, message, stack, url, wallet,
      severity, metadata, auto_fixed, user_agent
    ) VALUES (
      COALESCE((v_item->>'timestamp')::TIMESTAMPTZ, now()),
      COALESCE(v_item->>'category', 'unknown'),
      COALESCE(v_item->>'message', ''),
      COALESCE(v_item->>'stack', ''),
      COALESCE(v_item->>'url', ''),
      COALESCE(v_item->>'wallet', ''),
      COALESCE(v_item->>'severity', 'info'),
      COALESCE(v_item->'metadata', '{}'),
      COALESCE((v_item->>'auto_fixed')::BOOLEAN, false),
      COALESCE(v_item->>'user_agent', '')
    );
    v_count := v_count + 1;
  END LOOP;

  -- Cleanup: delete errors older than 30 days
  DELETE FROM public.app_errors WHERE created_at < now() - INTERVAL '30 days';

  RETURN jsonb_build_object('success', true, 'inserted', v_count);
END;
$$;

-- 4. Create the get_app_errors RPC (admin-only read)
CREATE OR REPLACE FUNCTION public.get_app_errors(
  p_admin_wallet TEXT,
  p_limit INTEGER DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin TEXT := '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1';
BEGIN
  -- Only admin can read
  IF lower(p_admin_wallet) <> lower(v_admin) THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthorized');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'errors', (
      SELECT jsonb_agg(row_to_json(e))
      FROM (
        SELECT id, timestamp, category, message, stack, url, wallet,
               severity, metadata, auto_fixed, user_agent, created_at
        FROM public.app_errors
        ORDER BY created_at DESC
        LIMIT p_limit
      ) e
    )
  );
END;
$$;

-- 5. Index for performance
CREATE INDEX IF NOT EXISTS idx_app_errors_created_at ON public.app_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_errors_category ON public.app_errors (category);
CREATE INDEX IF NOT EXISTS idx_app_errors_severity ON public.app_errors (severity);

-- ============================================================
-- VERIFY: Run these queries to confirm setup
-- ============================================================
-- SELECT * FROM public.app_errors LIMIT 5;
-- SELECT public.log_app_error('[{"category":"test","message":"test error","severity":"info"}]'::jsonb);
-- SELECT public.get_app_errors('0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1', 10);
