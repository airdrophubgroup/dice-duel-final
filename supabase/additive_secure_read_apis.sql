-- ============================================================
-- ADDITIVE SECURE READ APIS  (phase 1 of 2 — safe, adds only)
--
-- Why this exists
-- ---------------
-- The client reads `matches` and `user_rewards` DIRECTLY with the
-- publishable key. Verified against the live project: an unauthenticated
-- caller receives every row of both tables --
--
--   GET /rest/v1/user_rewards?select=*   -> 200, Content-Range 0-1/2
--                                          (every wallet address + balance)
--   GET /rest/v1/matches?select=*        -> 200, p1_address/p2_address
--
-- The client filters with .eq('wallet_address', ...), but that filter is
-- cosmetic: the table grant lets anyone drop it. World App's published
-- guidance is to show usernames instead of wallet addresses "to make it
-- more user-friendly and private", so this is a direct privacy failure.
--
-- This file ONLY ADDS server-side, address-free read paths and the missing
-- `secure_ensure_user_row` RPC (called by the client, defined nowhere --
-- so sign-in currently 404s here). Nothing is revoked, so applying this
-- file cannot break the running app.
--
-- Phase 2 (supabase/phase2_revoke_direct_reads.sql) then removes the
-- direct table grants. Run that ONLY after the client is serving these
-- RPCs and matchmaking has been exercised end to end.
--
-- Every statement is idempotent: safe to run more than once.
-- ============================================================


-- ============================================================
-- 1. secure_ensure_user_row  (fixes a real 404)
--
-- `full_security_lockdown.sql` GRANTs public.secure_ensure_user_row(text,
-- text) but never creates it, so that migration cannot have completed --
-- everything after its GRANT block is unapplied. The client calls this
-- with a single p_wallet, so the defaulted second parameter satisfies the
-- existing GRANT signature AND the single-argument call.
-- ============================================================
CREATE OR REPLACE FUNCTION public.secure_ensure_user_row(
  p_wallet   text,
  p_username text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_wallet text;
  v_name   text;
BEGIN
  v_wallet := lower(btrim(coalesce(p_wallet, '')));
  IF v_wallet = '' OR v_wallet !~ '^0x[0-9a-f]{40}$' THEN
    RETURN false;
  END IF;

  v_name := NULLIF(left(regexp_replace(btrim(coalesce(p_username, '')), '^@+', ''), 24), '');

  INSERT INTO public.user_rewards (wallet_address, tnv_balance, wld_balance, username)
  VALUES (v_wallet, 0, 0, v_name)
  ON CONFLICT (wallet_address) DO UPDATE
    SET username = COALESCE(EXCLUDED.username, public.user_rewards.username);

  RETURN true;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.secure_ensure_user_row(text, text) TO anon, authenticated;


-- ============================================================
-- 2. get_my_profile -- own balances only, no address echoed back
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_my_profile(p_wallet text)
RETURNS TABLE (
  tnv_balance  int,
  wld_balance  numeric,
  is_blocked   boolean,
  games_played int,
  games_won    int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT coalesce(ur.tnv_balance, 0)::int,
         coalesce(ur.wld_balance, 0)::numeric,
         coalesce(ur.is_blocked, false),
         coalesce(ur.games_played, 0)::int,
         coalesce(ur.games_won, 0)::int
    FROM public.user_rewards ur
   WHERE lower(ur.wallet_address) = lower(btrim(p_wallet))
   LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_profile(text) TO anon, authenticated;


-- ============================================================
-- 3. get_my_matches -- caller's matches, seat resolved server-side
--
-- Returns `is_p1` instead of the two address columns, so the client never
-- needs to receive a wallet address to work out which seat it occupies.
-- Opponent is identified by USERNAME only.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_my_matches(
  p_wallet text,
  p_limit  int DEFAULT 10
)
RETURNS TABLE (
  id                  uuid,
  status              text,
  fee                 numeric,
  created_at          timestamptz,
  is_p1               boolean,
  my_score            int,
  opp_score           int,
  my_taps             int,
  opp_taps            int,
  my_username         text,
  opp_username        text,
  winner_username     text,
  tie                 boolean,
  my_paid             boolean,
  opp_paid            boolean,
  my_payment_tx_hash  text,
  my_tnv_credited     boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH me AS (
    SELECT lower(btrim(p_wallet)) AS w
  )
  SELECT m.id,
         m.status,
         coalesce(m.fee, 0)::numeric,
         m.created_at,
         (lower(m.p1_address) = me.w)                                        AS is_p1,
         CASE WHEN lower(m.p1_address) = me.w THEN coalesce(m.p1_score, 0)
              ELSE coalesce(m.p2_score, 0) END::int                          AS my_score,
         CASE WHEN lower(m.p1_address) = me.w THEN coalesce(m.p2_score, 0)
              ELSE coalesce(m.p1_score, 0) END::int                          AS opp_score,
         CASE WHEN lower(m.p1_address) = me.w THEN coalesce(m.p1_taps_used, 0)
              ELSE coalesce(m.p2_taps_used, 0) END::int                      AS my_taps,
         CASE WHEN lower(m.p1_address) = me.w THEN coalesce(m.p2_taps_used, 0)
              ELSE coalesce(m.p1_taps_used, 0) END::int                      AS opp_taps,
         CASE WHEN lower(m.p1_address) = me.w THEN m.p1_username
              ELSE m.p2_username END                                     AS my_username,
         CASE WHEN lower(m.p1_address) = me.w THEN m.p2_username
              ELSE m.p1_username END                                     AS opp_username,
         m.winner_username,
         coalesce(m.tie, false),
         CASE WHEN lower(m.p1_address) = me.w THEN coalesce(m.p1_paid, false)
              ELSE coalesce(m.p2_paid, false) END                        AS my_paid,
         CASE WHEN lower(m.p1_address) = me.w THEN coalesce(m.p2_paid, false)
              ELSE coalesce(m.p1_paid, false) END                        AS opp_paid,
         CASE WHEN lower(m.p1_address) = me.w THEN m.p1_payment_tx_hash
              ELSE m.p2_payment_tx_hash END                             AS my_payment_tx_hash,
         CASE WHEN lower(m.p1_address) = me.w THEN coalesce(m.p1_tnv_credited, false)
              ELSE coalesce(m.p2_tnv_credited, false) END                AS my_tnv_credited
    FROM public.matches m, me
   WHERE lower(m.p1_address) = me.w
      OR lower(m.p2_address) = me.w
   ORDER BY m.created_at DESC
   LIMIT greatest(1, least(coalesce(p_limit, 10), 100));
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_matches(text, int) TO anon, authenticated;


-- ============================================================
-- 4. get_match_public -- match state for players, no addresses
--
-- Used by the live game poll (both players legitimately poll the same
-- row). Exposes scores, paid flags and usernames only.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_match_public(p_match_id uuid)
RETURNS TABLE (
  id            uuid,
  status        text,
  fee           numeric,
  p1_score      int,
  p2_score      int,
  p1_taps_used  int,
  p2_taps_used  int,
  p1_username   text,
  p2_username   text,
  p1_paid       boolean,
  p2_paid       boolean,
  tie           boolean,
  opponent_in   boolean,
  created_at    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT m.id,
         m.status,
         coalesce(m.fee, 0)::numeric,
         coalesce(m.p1_score, 0)::int,
         coalesce(m.p2_score, 0)::int,
         coalesce(m.p1_taps_used, 0)::int,
         coalesce(m.p2_taps_used, 0)::int,
         m.p1_username,
         m.p2_username,
         coalesce(m.p1_paid, false),
         coalesce(m.p2_paid, false),
         coalesce(m.tie, false),
         (m.p2_address IS NOT NULL) AS opponent_in,
         m.created_at
    FROM public.matches m
   WHERE m.id = p_match_id
   LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_match_public(uuid) TO anon, authenticated;


-- ============================================================
-- 5. find_my_match_by_tx_hash -- support bot, scoped to the caller
--
-- Previously the client searched `matches` with
-- .or('p1_payment_tx_hash.eq.<hash>,p2_payment_tx_hash.eq.<hash>'),
-- which leaked any match to anyone holding a transaction hash. This
-- returns a row only when the caller is a participant.
-- ============================================================
CREATE OR REPLACE FUNCTION public.find_my_match_by_tx_hash(
  p_tx_hash text,
  p_wallet  text
)
RETURNS TABLE (
  id           uuid,
  status       text,
  fee          numeric,
  created_at   timestamptz,
  is_p1        boolean,
  my_paid      boolean,
  opp_paid     boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH me AS (
    SELECT lower(btrim(p_wallet)) AS w
  )
  SELECT m.id,
         m.status,
         coalesce(m.fee, 0)::numeric,
         m.created_at,
         (lower(m.p1_address) = me.w) AS is_p1,
         CASE WHEN lower(m.p1_address) = me.w THEN coalesce(m.p1_paid, false)
              ELSE coalesce(m.p2_paid, false) END AS my_paid,
         CASE WHEN lower(m.p1_address) = me.w THEN coalesce(m.p2_paid, false)
              ELSE coalesce(m.p1_paid, false) END AS opp_paid
    FROM public.matches m, me
   WHERE (lower(m.p1_payment_tx_hash) = lower(btrim(p_tx_hash))
       OR lower(m.p2_payment_tx_hash) = lower(btrim(p_tx_hash)))
     AND (lower(m.p1_address) = me.w OR lower(m.p2_address) = me.w)
   LIMIT 5;
$function$;

GRANT EXECUTE ON FUNCTION public.find_my_match_by_tx_hash(text, text) TO anon, authenticated;


-- ============================================================
-- 6. admin_get_stuck_matches -- replaces an unfiltered admin read
--
-- The admin panel used to SELECT every 'playing' match with no filter.
--
-- !! KNOWN WEAKNESS — do not treat this as access control !!
-- This mirrors the pattern already used by admin_get_cheaters,
-- admin_get_revenue, admin_get_daily_revenue, admin_get_tickets and
-- admin_get_alerts in full_security_lockdown.sql: a hardcoded admin
-- address literal inside the function. Verified live: calling those with
-- the publishable key and p_admin_wallet set to the address that ships in
-- app.js returns HTTP 200 rather than denying.
--
-- The reason is structural: with no authenticated identity, the server
-- cannot tell "this IS the admin" from "the caller typed the admin's
-- address". Every admin check in this codebase is therefore bypassable by
-- anyone who reads the client bundle. Adding an is_admin DB flag would NOT
-- help -- it would still be looked up using a caller-supplied address.
--
-- The only real fix is the SIWE auth work (docs/SIWE_SETUP.md), after which
-- these gates must switch to (select auth.uid()) / a verified wallet
-- mapping. Until then, admin data is effectively public.
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_get_stuck_matches(
  p_admin_wallet text,
  p_age_seconds  int DEFAULT 120
)
RETURNS TABLE (
  id          uuid,
  fee         numeric,
  created_at  timestamptz,
  p1_username text,
  p2_username text,
  p1_paid     boolean,
  p2_paid     boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  -- Same (weak) gate as the other admin RPCs -- see the warning above.
  IF lower(btrim(coalesce(p_admin_wallet, ''))) <> '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT m.id,
         coalesce(m.fee, 0)::numeric,
         m.created_at,
         m.p1_username,
         m.p2_username,
         coalesce(m.p1_paid, false),
         coalesce(m.p2_paid, false)
    FROM public.matches m
   WHERE m.status = 'playing'
     AND m.created_at < now() - make_interval(secs => greatest(30, coalesce(p_age_seconds, 120)))
   ORDER BY m.created_at
   LIMIT 50;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_get_stuck_matches(text, int) TO anon, authenticated;


-- ============================================================
-- 7. SIWE / auth scaffolding  (NOT yet usable -- see the doc)
--
-- Real per-user RLS needs an authenticated identity. Supabase can issue
-- one via signInWithWeb3, but (a) the Web3 provider must be enabled and
-- (b) the wallet claim path in the issued JWT is NOT documented, so no
-- policy below trusts an unverified claim.
--
-- This table is the documented alternative: map the Supabase user UUID
-- to a verified wallet address, then key policies off auth.uid().
-- Populate it ONLY from a verified signature -- never from user-asserted
-- input. See docs/SIWE_SETUP.md for the required dashboard steps and for
-- a query to inspect the real JWT before trusting any claim.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.wallet_accounts (
  user_id    uuid NOT NULL,
  address    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, address)
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_accounts_lower_address_key
  ON public.wallet_accounts (lower(address));

ALTER TABLE public.wallet_accounts ENABLE ROW LEVEL SECURITY;

-- Authenticated users may read only their OWN mapping. No INSERT/UPDATE
-- policy is granted: rows are created exclusively by trusted server code,
-- so a client cannot claim a wallet it does not control.
DROP POLICY IF EXISTS "read own wallet mappings" ON public.wallet_accounts;
CREATE POLICY "read own wallet mappings"
  ON public.wallet_accounts
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

REVOKE ALL ON public.wallet_accounts FROM anon;
GRANT SELECT ON public.wallet_accounts TO authenticated;


-- ============================================================
-- 8. Post-run verification
-- ============================================================
-- SELECT proname, pg_get_function_identity_arguments(oid) AS args
--   FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--  ORDER BY proname;

DO $$
BEGIN
  RAISE NOTICE 'Phase 1 applied: secure_ensure_user_row, get_my_profile, get_my_matches, get_match_public, find_my_match_by_tx_hash, admin_get_stuck_matches.';
  RAISE NOTICE 'Next: point the client at these RPCs, test matchmaking, THEN run phase2_revoke_direct_reads.sql.';
  RAISE NOTICE 'Residual: admin RPCs remain bypassable until SIWE auth lands (docs/SIWE_SETUP.md).';
END $$;
