-- ============================================================
-- FIX: "Making users pay before finding an opponent"
-- 
-- The reviewer rejected the app because players were required
-- to pay WLD before an opponent was even found.
--
-- Root cause: join_or_create_match required p1_paid = true to
-- join an existing waiting match. This forced P1 to pay FIRST,
-- then wait for P2. The fix: allow joining without payment.
-- Both players match FIRST, THEN pay.
--
-- New flow:
--   1. P1 creates match (status='waiting', p1_paid=false)
--   2. P2 joins match (status='matched') — NO payment needed yet
--   3. Both players see "Opponent found!"
--   4. Both players prompted to pay
--   5. Both paid → game starts
-- ============================================================

CREATE OR REPLACE FUNCTION public.join_or_create_match(
  p_address text,
  p_fee numeric,
  p_username text
) RETURNS SETOF public.matches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match public.matches;
  v_clean_address text := lower(trim(p_address));
BEGIN
  -- P2 joins: find ANY waiting match with the same fee, no p1_paid
  -- requirement. This lets players find each other BEFORE paying.
  -- The 90-second window prevents joining stale/orphaned matches.
  SELECT * INTO v_match
  FROM public.matches
  WHERE status = 'waiting'
    AND fee = p_fee
    AND lower(trim(p1_address)) != v_clean_address
    AND p2_address IS NULL
    AND created_at > now() - interval '90 seconds'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF found THEN
    -- Second player joined: mark the match 'matched' so the app's
    -- readiness poll can see it. Payment happens AFTER matching.
    UPDATE public.matches
    SET p2_address = v_clean_address,
        p2_username = p_username,
        p2_paid = false,
        status = 'matched'
    WHERE id = v_match.id
    RETURNING * INTO v_match;

    RETURN NEXT v_match;
  ELSE
    -- No waiting match available — create a new one as P1.
    INSERT INTO public.matches (
      p1_address,
      p1_username,
      fee,
      status,
      match_id,
      p1_paid,
      p2_paid,
      game_started,
      p1_score,
      p2_score
    ) VALUES (
      v_clean_address,
      p_username,
      p_fee,
      'waiting',
      gen_random_uuid()::text,
      false,
      false,
      false,
      0,
      0
    )
    RETURNING * INTO v_match;

    RETURN NEXT v_match;
  END IF;
END;
$$;
