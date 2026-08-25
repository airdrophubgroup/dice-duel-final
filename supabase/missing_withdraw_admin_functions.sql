-- ============================================================
-- MISSING RPC RECOVERY — 2026-08-25
--
-- Full-app audit found 3 RPCs called by app.js that existed ONLY on
-- the live database and in NO tracked SQL file. This file restores
-- them so a fresh Supabase project can be rebuilt from git.
--
-- Safe to run on an existing project: CREATE OR REPLACE only,
-- signatures exactly match the app.js rpc() calls:
--   secure_submit_withdraw_request(p_wallet, p_amount)
--   admin_approve_withdrawal(p_admin_wallet, p_req_id, p_tx_hash)
--   secure_admin_block_user(p_admin_wallet, p_target_wallet)
-- ============================================================

-- 0. Ensure withdraw_requests exists (fresh-project safety net)
CREATE TABLE IF NOT EXISTS public.withdraw_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  tx_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS withdraw_requests_wallet_idx
  ON public.withdraw_requests (wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS withdraw_requests_status_idx
  ON public.withdraw_requests (status, created_at);

ALTER TABLE public.withdraw_requests ENABLE ROW LEVEL SECURITY;

-- RLS: deny all direct access — everything goes through the RPCs below.
DROP POLICY IF EXISTS "withdraw_requests_deny_all" ON public.withdraw_requests;
CREATE POLICY "withdraw_requests_deny_all" ON public.withdraw_requests
  FOR SELECT USING (false);

GRANT EXECUTE ON FUNCTION public.secure_submit_withdraw_request(text, numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_approve_withdrawal(text, uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.secure_admin_block_user(text, text) TO anon;

-- ============================================================
-- 1. secure_submit_withdraw_request
--    User requests a TNV withdrawal. Server validates the minimum
--    (5,000 TNV), blocks banned users, and allows only ONE open
--    request per wallet so balances can't be double-committed.
-- ============================================================
CREATE OR REPLACE FUNCTION public.secure_submit_withdraw_request(
  p_wallet text,
  p_amount numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_wallet text := lower(trim(p_wallet));
  v_balance numeric;
BEGIN
  IF v_wallet IS NULL OR length(v_wallet) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid wallet');
  END IF;

  IF p_amount IS NULL OR p_amount < 5000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Minimum withdrawal is 5,000 TNV');
  END IF;

  -- Banned users cannot withdraw
  IF EXISTS (
    SELECT 1 FROM public.user_rewards
    WHERE lower(wallet_address) = v_wallet AND coalesce(is_blocked, false)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'account_blocked');
  END IF;

  SELECT tnv_balance INTO v_balance
  FROM public.user_rewards
  WHERE lower(wallet_address) = v_wallet;

  IF v_balance IS NULL OR p_amount > v_balance THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient TNV balance');
  END IF;

  -- One open request per wallet: prevents committing the same TNV twice
  IF EXISTS (
    SELECT 1 FROM public.withdraw_requests
    WHERE lower(wallet_address) = v_wallet AND status = 'pending'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'You already have a pending withdrawal request');
  END IF;

  INSERT INTO public.withdraw_requests (wallet_address, amount, status)
  VALUES (v_wallet, p_amount, 'pending');

  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- 2. admin_approve_withdrawal
--    Admin marks a request approved and records the paying tx hash.
--    Idempotent-safe: only a PENDING request can be approved.
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_approve_withdrawal(
  p_admin_wallet text,
  p_req_id uuid,
  p_tx_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_admin text := lower(trim(p_admin_wallet));
BEGIN
  IF v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  IF p_tx_hash IS NULL OR length(trim(p_tx_hash)) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'valid tx hash required');
  END IF;

  UPDATE public.withdraw_requests
  SET status = 'approved',
      tx_hash = lower(trim(p_tx_hash)),
      processed_at = now()
  WHERE id = p_req_id AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'request not found or already processed');
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- 3. secure_admin_block_user
--    Admin bans a cheater: is_blocked=true on user_rewards makes the
--    client show the blocked screen and every secure RPC rejects them.
-- ============================================================
CREATE OR REPLACE FUNCTION public.secure_admin_block_user(
  p_admin_wallet text,
  p_target_wallet text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_admin text := lower(trim(p_admin_wallet));
  v_target text := lower(trim(p_target_wallet));
BEGIN
  IF v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  IF v_target = v_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot block yourself');
  END IF;

  UPDATE public.user_rewards
  SET is_blocked = true
  WHERE lower(wallet_address) = v_target;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'user not found');
  END IF;

  -- Audit trail (best-effort; table may not exist on very old projects)
  BEGIN
    INSERT INTO public.security_audit_log (action, actor, target, created_at)
    VALUES ('block_user', v_admin, v_target, now());
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;
