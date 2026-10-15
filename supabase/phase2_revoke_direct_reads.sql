-- ============================================================
-- PHASE 2 — REVOKE DIRECT TABLE READS   (** DESTRUCTIVE **)
--
-- !! DO NOT RUN THIS UNTIL THE CLIENT NO LONGER READS THESE TABLES !!
--
-- Read the warning before executing anything.
--
-- Verified live before this file was written: with only the publishable
-- key that ships in the client bundle, an unauthenticated caller can read
-- EVERY row of both tables --
--
--   GET /rest/v1/user_rewards?select=*  -> 200, Content-Range 0-1/2
--        every wallet address + TNV/WLD balance
--   GET /rest/v1/matches?select=*       -> 200, p1_address + p2_address
--
-- The client's .eq('wallet_address', ...) filters are cosmetic: the grant,
-- not the filter, is what protects data, and the grant is currently open.
--
-- WHY THIS IS SEPARATE FROM PHASE 1
-- ---------------------------------
-- app.js still reads both tables directly in ~20 places. Revoking before
-- those call sites are moved onto the phase-1 RPCs will break matchmaking,
-- the withdrawal panel and the support bot in production. Supabase will
-- NOT warn you -- the client will simply start receiving 401s.
--
-- ORDER OF OPERATIONS
--   1. Run  supabase/additive_secure_read_apis.sql          (phase 1)
--   2. Run  supabase/leaderboard_usernames.sql              (leaderboard)
--   3. Run  supabase/public_stats_rpc.sql                   (live stats)
--   4. Refactor app.js to call the RPCs instead of .from()
--   5. Play a full match, request a withdrawal, open support, check Ranks
--   6. ONLY THEN run this file
--   7. Re-test the same five flows, signed out and signed in
-- ============================================================


-- ------------------------------------------------------------
-- 0. Pre-flight: what is still exposed? Run this first and read it.
--    If the RPCs from phase 1 are missing, stop and apply phase 1.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(f) INTO v_missing
    FROM unnest(ARRAY[
      'secure_ensure_user_row', 'get_my_profile', 'get_my_matches',
      'get_match_public', 'find_my_match_by_tx_hash', 'get_leaderboard'
    ]) AS f
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc
      WHERE proname = f AND pronamespace = 'public'::regnamespace
   );

  IF v_missing IS NOT NULL AND array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION
      'ABORTING: these phase-1 RPCs are missing: %. Apply additive_secure_read_apis.sql first.',
      array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE 'Pre-flight OK — phase-1 RPCs present.';
END $$;


-- ------------------------------------------------------------
-- 1. Enable RLS. With no policy, the default is DENY for
--    anon/authenticated. SECURITY DEFINER RPCs are unaffected because
--    they execute with the definer's privileges.
-- ------------------------------------------------------------
ALTER TABLE public.matches       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_rewards  ENABLE ROW LEVEL SECURITY;

-- Belt and braces: RLS only applies to roles that still hold a table
-- grant, so remove the grants too. Revoking the grant is what actually
-- closes the hole; RLS is the layer that survives a future GRANT.
REVOKE ALL PRIVILEGES ON public.matches       FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON public.user_rewards  FROM anon, authenticated;

-- Deliberately no SELECT/INSERT/UPDATE/DELETE policies on either table:
-- every legitimate access now goes through a SECURITY DEFINER RPC that
-- filters server-side or returns no wallet address at all.


-- ------------------------------------------------------------
-- 2. Defence in depth: strip addresses from what the RPCs return.
--    get_leaderboard (phase 1 of the leaderboard work) already returns
--    only rank / display name / balance. These comments record the
--    contract so a future edit does not quietly re-add an address column.
-- ------------------------------------------------------------
COMMENT ON TABLE public.user_rewards IS
  'Balances + flags. No client role may read this directly; use get_my_profile / get_leaderboard. RPCs must never return wallet_address.';

COMMENT ON TABLE public.matches IS
  'Match state. No client role may read this directly; use get_my_matches / get_match_public. RPCs must never return p1_address or p2_address.';


-- ------------------------------------------------------------
-- 3. Post-flight verification. Expect every row to read "denied".
-- ------------------------------------------------------------
DO $$
BEGIN
  RAISE NOTICE 'Phase 2 applied. Now verify from OUTSIDE the database:';
  RAISE NOTICE '  curl -i "<url>/rest/v1/user_rewards?select=*" -H "apikey: <publishable>"';
  RAISE NOTICE '  curl -i "<url>/rest/v1/matches?select=*"      -H "apikey: <publishable>"';
  RAISE NOTICE 'Expect 401 / 403, NOT 200. Then re-test: full match, withdrawal, support bot, Ranks tab, signed in and out.';
END $$;

-- Manual check afterwards:
--   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name IN ('matches','user_rewards') AND grantee IN ('anon','authenticated');
-- Both should come back empty for those two tables.
