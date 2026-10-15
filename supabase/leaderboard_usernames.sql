-- ============================================================
-- LEADERBOARD USERNAMES — privacy-safe leaderboard
--
-- Guideline fix: the Ranks tab previously read user_rewards rows
-- directly with the anon key and rendered truncated WALLET
-- ADDRESSES ("0x8c5b...b6a1"). The World App guidelines ask apps
-- to show usernames rather than wallet addresses, and a public
-- board should never disgorge raw wallet data.
--
-- Changes:
--   1. user_rewards.username — cached World App username.
--   2. set_user_username(...) — the client records its resolved
--      username once per session.
--   3. get_leaderboard()      — SECURITY DEFINER RPC returning ONLY
--      rank, display name and TNV balance. Wallet addresses never
--      leave the database.
--
-- Safe to run more than once (all statements are idempotent).
-- ============================================================

-- 1. Cached username column ----------------------------------
ALTER TABLE public.user_rewards
  ADD COLUMN IF NOT EXISTS username text;

-- Backfill from the most recent match either player appeared in.
UPDATE public.user_rewards ur
   SET username = m.nm
  FROM (
    SELECT DISTINCT ON (w) w, nm FROM (
      SELECT lower(p1_address) AS w, p1_username AS nm, created_at
        FROM public.matches WHERE p1_address IS NOT NULL AND p1_username IS NOT NULL AND p1_username <> ''
      UNION ALL
      SELECT lower(p2_address) AS w, p2_username AS nm, created_at
        FROM public.matches WHERE p2_address IS NOT NULL AND p2_username IS NOT NULL AND p2_username <> ''
    ) x
    ORDER BY w, created_at DESC
  ) m
 WHERE lower(ur.wallet_address) = m.w
   AND (ur.username IS NULL OR ur.username = '');

-- 2. Record the caller's username ----------------------------
CREATE OR REPLACE FUNCTION public.set_user_username(
  p_wallet text,
  p_username text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_name text;
BEGIN
  v_name := btrim(coalesce(p_username, ''));
  -- Strip a leading @ and cap the stored value.
  v_name := left(regexp_replace(v_name, '^@+', ''), 24);
  IF p_wallet IS NULL OR v_name = '' THEN
    RETURN false;
  END IF;

  UPDATE public.user_rewards
     SET username = v_name
   WHERE lower(wallet_address) = lower(p_wallet);

  -- If the player has no rewards row yet, create a minimal one so the
  -- username is ready the moment they appear on the board.
  IF NOT FOUND THEN
    INSERT INTO public.user_rewards (wallet_address, tnv_balance, username)
    VALUES (lower(p_wallet), 0, v_name)
    ON CONFLICT (wallet_address) DO UPDATE SET username = EXCLUDED.username;
  END IF;

  RETURN true;
END;
$function$;

-- 3. Public leaderboard --------------------------------------
CREATE OR REPLACE FUNCTION public.get_leaderboard()
RETURNS TABLE (rank int, display_name text, tnv_balance int)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH top AS (
    SELECT ur.wallet_address,
           coalesce(ur.tnv_balance, 0) AS tnv_balance,
           ur.username,
           row_number() OVER (
             ORDER BY coalesce(ur.tnv_balance, 0) DESC, ur.wallet_address ASC
           ) AS rn
      FROM public.user_rewards ur
     WHERE coalesce(ur.is_blocked, false) = false
       AND coalesce(ur.tnv_balance, 0) > 0
     ORDER BY coalesce(ur.tnv_balance, 0) DESC, ur.wallet_address ASC
     LIMIT 10
  )
  SELECT t.rn::int AS rank,
         CASE
           WHEN coalesce(nullif(btrim(t.username), ''), '') <> ''
             THEN '@' || t.username
           ELSE 'Player ' || lpad((abs(hashtext(t.wallet_address)) % 9000 + 1000)::text, 4, '0')
         END AS display_name,
         t.tnv_balance::int AS tnv_balance
    FROM top t
   ORDER BY t.rn;
$function$;

-- 4. Grants ---------------------------------------------------
GRANT EXECUTE ON FUNCTION public.set_user_username(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_leaderboard() TO anon, authenticated;
