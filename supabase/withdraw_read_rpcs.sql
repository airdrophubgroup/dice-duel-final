-- ============================================================
-- WITHDRAW REQUEST READ RPCs
--
-- The security lockdown put a DENY ALL SELECT policy on
-- withdraw_requests (correct for privacy), but the app still needs:
--   1. A user seeing THEIR OWN request statuses (home + withdrawals modal)
--   2. The ADMIN seeing ALL requests (admin dashboard)
-- Direct table reads therefore return empty. These SECURITY DEFINER
-- RPCs restore both flows without reopening the table.
--
-- Run this ONCE in Supabase SQL Editor (safe to re-run).
-- ============================================================

-- ------------------------------------------------------------
-- 1. get_my_withdraw_requests
--    Returns ONLY the caller's own rows: amount, status, created_at.
--    No wallet addresses of others, no tx hashes (data minimization).
--    Cap at 10 most recent rows.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_withdraw_requests(
  p_wallet text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_wallet text := lower(trim(p_wallet));
BEGIN
  IF v_wallet IS NULL OR length(v_wallet) < 10 THEN
    RETURN jsonb_build_object('success', false, 'requests', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'requests', (
      SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
      FROM (
        SELECT r.amount, r.status, r.created_at
        FROM public.withdraw_requests r
        WHERE lower(r.wallet_address) = v_wallet
        ORDER BY r.created_at DESC
        LIMIT 10
      ) t
    )
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'requests', '[]'::jsonb);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_withdraw_requests(text) TO anon;

-- ------------------------------------------------------------
-- 2. admin_get_withdraw_requests
--    Admin-only view of ALL requests (wallet, amount, status,
--    tx_hash, timestamps) for the approval dashboard.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_withdraw_requests(
  p_admin_wallet text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_admin text := lower(trim(p_admin_wallet));
BEGIN
  IF v_admin <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized', 'requests', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'requests', (
      SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
      FROM (
        SELECT r.id, r.wallet_address, r.amount, r.status,
               r.tx_hash, r.created_at, r.processed_at
        FROM public.withdraw_requests r
        ORDER BY r.created_at DESC
        LIMIT 200
      ) t
    )
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'requests', '[]'::jsonb);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_get_withdraw_requests(text) TO anon;
