-- ============================================================
-- UNIFIED MIGRATION — Run this ONCE to get the latest state
-- of ALL critical functions. Safe to re-run (CREATE OR REPLACE).
-- ============================================================

-- 1. join_or_create_match (search-before-pay version)
-- Allows opponents to join BEFORE anyone pays. Both players
-- match FIRST, THEN pay.
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
    UPDATE public.matches
    SET p2_address = v_clean_address,
        p2_username = p_username,
        p2_paid = false,
        status = 'matched'
    WHERE id = v_match.id
    RETURNING * INTO v_match;
    RETURN NEXT v_match;
  ELSE
    -- CONCURRENCY GUARD: if this wallet ALREADY has a live match
    -- (waiting/matched/playing), return it instead of inserting a
    -- duplicate row. Without this, rapid taps or 100 simultaneous
    -- users flood the waiting pool with stale duplicates.
    SELECT * INTO v_match
    FROM public.matches
    WHERE status IN ('waiting', 'matched', 'playing', 'searching')
      AND lower(trim(p1_address)) = v_clean_address
      AND created_at > now() - interval '5 minutes'
    ORDER BY created_at DESC
    LIMIT 1;
    IF found THEN
      RETURN NEXT v_match;
      RETURN;
    END IF;

    INSERT INTO public.matches (
      p1_address, p1_username, fee, status, match_id,
      p1_paid, p2_paid, game_started, p1_score, p2_score
    ) VALUES (
      v_clean_address, p_username, p_fee, 'waiting',
      gen_random_uuid()::text, false, false, false, 0, 0
    )
    RETURNING * INTO v_match;
    RETURN NEXT v_match;
  END IF;
END;
$$;

-- 2. secure_start_match (requires BOTH players paid)
CREATE OR REPLACE FUNCTION public.secure_start_match(
  p_match_id uuid,
  p_wallet text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match matches%ROWTYPE;
  v_wallet text := lower(p_wallet);
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'not_found'); END IF;
  IF v_match.p1_address IS DISTINCT FROM v_wallet AND v_match.p2_address IS DISTINCT FROM v_wallet THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_participant');
  END IF;
  IF v_match.status = 'matched' THEN
    IF NOT coalesce(v_match.p1_paid, false) OR NOT coalesce(v_match.p2_paid, false) THEN
      RETURN jsonb_build_object('success', false, 'error', 'both_players_must_pay');
    END IF;
    UPDATE matches SET game_started = true, status = 'playing', start_time = now() WHERE id = p_match_id;
    RETURN jsonb_build_object('success', true, 'status', 'playing');
  END IF;
  IF v_match.status = 'playing' AND v_match.game_started THEN
    RETURN jsonb_build_object('success', true, 'status', 'playing');
  END IF;
  RETURN jsonb_build_object('success', false, 'error', 'match_not_ready');
END;
$$;

-- 3. secure_leave_waiting_match (anti-flood version, returns jsonb)
CREATE OR REPLACE FUNCTION public.secure_leave_waiting_match(
  p_match_id uuid,
  p_wallet text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_wallet text := lower(trim(p_wallet));
  v_row public.matches;
BEGIN
  SELECT * INTO v_row FROM public.matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'match not found');
  END IF;

  IF lower(coalesce(v_row.p1_address, '')) <> v_wallet
     AND lower(coalesce(v_row.p2_address, '')) <> v_wallet THEN
    RETURN jsonb_build_object('success', false, 'error', 'not a participant');
  END IF;

  IF coalesce(v_row.game_started, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'game already started');
  END IF;

  UPDATE public.matches
  SET status = 'cancelled'
  WHERE id = p_match_id
    AND (p1_address = v_wallet or p2_address = v_wallet)
    AND status IN ('waiting', 'searching', 'matched')
    AND coalesce(game_started, false) = false;

  RETURN jsonb_build_object('success', true);
END;
$function$;

-- 4. secure_roll_dice (server-authoritative, anti rapid-fire)
CREATE OR REPLACE FUNCTION public.secure_roll_dice(
  p_match_id uuid,
  p_wallet text,
  p_roll int4
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m record;
  is_p1 boolean;
  current_taps int;
  current_score bigint;
  last_roll timestamptz;
  max_taps constant int := 15;
BEGIN
  IF p_roll IS NULL OR p_roll < 1 OR p_roll > 6 THEN
    RETURN json_build_object('success', false, 'error', 'Invalid roll (must be 1-6)');
  END IF;

  SELECT * INTO m FROM public.matches WHERE id = p_match_id AND status = 'playing';
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Match not active');
  END IF;

  IF m.start_time IS NOT NULL AND now() > m.start_time + interval '35 seconds' THEN
    RETURN json_build_object('success', false, 'error', 'Round time expired');
  END IF;

  IF lower(m.p1_address) = lower(p_wallet) THEN
    is_p1 := true;
    current_taps := coalesce(m.p1_taps_used, 0);
    current_score := coalesce(m.p1_score, 0);
    last_roll := m.p1_last_roll_at;
  ELSIF lower(m.p2_address) = lower(p_wallet) THEN
    is_p1 := false;
    current_taps := coalesce(m.p2_taps_used, 0);
    current_score := coalesce(m.p2_score, 0);
    last_roll := m.p2_last_roll_at;
  ELSE
    RETURN json_build_object('success', false, 'error', 'Unauthorized player');
  END IF;

  IF current_taps >= max_taps THEN
    RETURN json_build_object('success', false, 'error', 'Max turns exceeded');
  END IF;

  IF last_roll IS NOT NULL AND now() - last_roll < interval '2 seconds' THEN
    RETURN json_build_object('success', false, 'error', 'Roll too fast — wait 2 seconds between taps');
  END IF;

  IF is_p1 THEN
    UPDATE public.matches
    SET p1_score = current_score + p_roll,
        p1_taps_used = current_taps + 1,
        p1_last_roll_at = now()
    WHERE id = p_match_id;
  ELSE
    UPDATE public.matches
    SET p2_score = current_score + p_roll,
        p2_taps_used = current_taps + 1,
        p2_last_roll_at = now()
    WHERE id = p_match_id;
  END IF;

  RETURN json_build_object('success', true, 'new_score', current_score + p_roll, 'taps_left', max_taps - (current_taps + 1));
END;
$$;

-- 5. secure_complete_match (tie support)
CREATE OR REPLACE FUNCTION public.secure_complete_match(
  p_match_id uuid,
  p_wallet text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match matches%ROWTYPE;
  v_wallet text := lower(p_wallet);
  v_winner_address text;
  v_winner_username text;
  v_payout numeric;
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'not_found'); END IF;
  IF v_match.p1_address IS DISTINCT FROM v_wallet AND v_match.p2_address IS DISTINCT FROM v_wallet THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_participant');
  END IF;

  IF v_match.status = 'playing' THEN
    IF v_match.p1_score > v_match.p2_score THEN
      v_winner_address := v_match.p1_address; v_winner_username := v_match.p1_username;
    ELSIF v_match.p2_score > v_match.p1_score THEN
      v_winner_address := v_match.p2_address; v_winner_username := v_match.p2_username;
    ELSE
      v_winner_address := 'tie'; v_winner_username := 'tie';
      v_payout := 0;
    END IF;

    v_payout := CASE COALESCE(v_match.fee, 0.5)
      WHEN 0.1 THEN 0.17 WHEN 0.2 THEN 0.34 WHEN 0.5 THEN 0.80 WHEN 1 THEN 1.60
      WHEN 2 THEN 3.20 WHEN 5 THEN 8.80 WHEN 10 THEN 17.8 WHEN 20 THEN 36.0
      WHEN 30 THEN 54.0 WHEN 40 THEN 72.0 WHEN 50 THEN 90.0
      ELSE ROUND(COALESCE(v_match.fee, 0.5) * 1.6, 2)
    END;

    UPDATE matches
    SET status = 'completed',
        winner_address = v_winner_address,
        winner_username = v_winner_username,
        payout_amount = v_payout,
        tie = (v_winner_address = 'tie')
    WHERE id = p_match_id AND status = 'playing';
  END IF;

  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  RETURN jsonb_build_object('success', true, 'match', to_jsonb(v_match));
END;
$$;

-- 6. record_verified_payment (the ONLY way to mark a player paid)
CREATE OR REPLACE FUNCTION public.record_verified_payment(
  p_match_id uuid,
  p_wallet text,
  p_tx_hash text
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet text := lower(trim(p_wallet));
  v_tx text := lower(trim(p_tx_hash));
  v_row public.matches;
  v_is_p1 boolean;
BEGIN
  IF v_tx IS NULL OR length(v_tx) < 10 THEN
    RETURN json_build_object('success', false, 'error', 'invalid tx hash');
  END IF;

  SELECT * INTO v_row FROM public.matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'match not found');
  END IF;

  IF v_row.status NOT IN ('waiting', 'matched', 'searching', 'cancelled') THEN
    RETURN json_build_object('success', false, 'error', 'match not in payable state: ' || coalesce(v_row.status, 'null'));
  END IF;
  -- NOTE: 'cancelled' is intentionally ACCEPTED here. A player whose
  -- on-chain payment was already broadcast must still get it verified
  -- after the opponent cancels — otherwise their fee is stranded with
  -- no way to ever queue a refund (real fund-loss scenario). A cancelled
  -- match can never be played (secure_start_match only accepts
  -- 'matched'), so a late verification can only ever lead to a refund
  -- of the player's OWN verified payment.

  IF lower(coalesce(v_row.p1_address, '')) = v_wallet THEN
    v_is_p1 := true;
  ELSIF lower(coalesce(v_row.p2_address, '')) = v_wallet THEN
    v_is_p1 := false;
  ELSE
    RETURN json_build_object('success', false, 'error', 'wallet is not a participant');
  END IF;

  IF exists (
    SELECT 1 FROM public.matches
    WHERE (p1_payment_tx_hash = v_tx OR p2_payment_tx_hash = v_tx)
      AND id <> p_match_id
  ) THEN
    RETURN json_build_object('success', false, 'error', 'tx hash already used for another match');
  END IF;

  IF v_is_p1 THEN
    UPDATE public.matches SET p1_paid = true, p1_payment_tx_hash = v_tx WHERE id = p_match_id;
  ELSE
    UPDATE public.matches SET p2_paid = true, p2_payment_tx_hash = v_tx WHERE id = p_match_id;
  END IF;

  RETURN json_build_object('success', true, 'player', CASE WHEN v_is_p1 THEN 'p1' ELSE 'p2' END);
END;
$$;

-- 7. queue_refund_request (hardened: requires paid + tx hash proof)
CREATE OR REPLACE FUNCTION public.queue_refund_request(
  p_match_id uuid,
  p_wallet text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_fee numeric;
  v_status text;
  v_p1 text;
  v_p2 text;
  v_p1_paid boolean;
  v_p2_paid boolean;
  v_p1_tx text;
  v_p2_tx text;
  v_tie boolean;
  v_wallet text := lower(trim(p_wallet));
BEGIN
  SELECT fee, status, p1_address, p2_address, p1_paid, p2_paid,
         p1_payment_tx_hash, p2_payment_tx_hash, tie
    INTO v_fee, v_status, v_p1, v_p2, v_p1_paid, v_p2_paid,
         v_p1_tx, v_p2_tx, v_tie
    FROM public.matches WHERE id = p_match_id LIMIT 1;

  IF v_fee IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'match not found');
  END IF;

  IF v_status NOT IN ('waiting', 'searching', 'cancelled') THEN
    IF NOT (v_status = 'completed' AND coalesce(v_tie, false)) THEN
      RETURN json_build_object('success', false, 'error', 'match not refundable in status ' || coalesce(v_status, 'unknown'));
    END IF;
  END IF;

  IF v_wallet = lower(v_p1) AND v_p1_paid AND v_p1_tx IS NOT NULL THEN
    NULL;
  ELSIF v_wallet = lower(v_p2) AND v_p2_paid AND v_p2_tx IS NOT NULL THEN
    NULL;
  ELSE
    RETURN json_build_object('success', false, 'error', 'wallet is not a verified paid participant of this match');
  END IF;

  INSERT INTO public.refund_queue (match_id, wallet_address, fee, status)
  VALUES (p_match_id, v_wallet, v_fee, 'pending');

  RETURN json_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- 8. secure_credit_tnv (one-time per player per match)
CREATE OR REPLACE FUNCTION public.secure_credit_tnv(
  p_match_id uuid,
  p_wallet text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match matches%ROWTYPE;
  v_wallet text := lower(p_wallet);
  v_is_p1 boolean;
  v_is_win boolean;
  v_tnv_base int;
  v_earned int;
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'not_found'); END IF;
  IF v_match.p1_address IS DISTINCT FROM v_wallet AND v_match.p2_address IS DISTINCT FROM v_wallet THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_participant');
  END IF;

  IF v_match.status <> 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'match_not_completed');
  END IF;

  v_is_p1 := (v_match.p1_address = v_wallet);
  IF v_is_p1 AND NOT coalesce(v_match.p1_paid, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'player_not_paid');
  END IF;
  IF NOT v_is_p1 AND NOT coalesce(v_match.p2_paid, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'player_not_paid');
  END IF;

  IF v_is_p1 AND v_match.p1_tnv_credited THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_credited');
  END IF;
  IF NOT v_is_p1 AND v_match.p2_tnv_credited THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_credited');
  END IF;

  v_is_win := (CASE WHEN v_is_p1 THEN v_match.p1_score ELSE v_match.p2_score END)
            > (CASE WHEN v_is_p1 THEN v_match.p2_score ELSE v_match.p1_score END);

  v_tnv_base := CASE COALESCE(v_match.fee, 0.5)
    WHEN 0.1 THEN 5 WHEN 0.2 THEN 10 WHEN 0.5 THEN 15 WHEN 1 THEN 25
    WHEN 2 THEN 50 WHEN 5 THEN 125 WHEN 10 THEN 250 WHEN 20 THEN 500
    WHEN 30 THEN 750 WHEN 40 THEN 1000 WHEN 50 THEN 1250 ELSE 15
  END;
  v_earned := CASE WHEN v_is_win THEN v_tnv_base ELSE floor(v_tnv_base / 3.0) END;

  UPDATE user_rewards
  SET tnv_balance = COALESCE(tnv_balance, 0) + v_earned,
      total_games = COALESCE(total_games, 0) + 1,
      games_played = COALESCE(games_played, 0) + 1,
      games_won = COALESCE(games_won, 0) + (CASE WHEN v_is_win THEN 1 ELSE 0 END)
  WHERE wallet_address = v_wallet;

  IF v_is_p1 THEN
    UPDATE matches SET p1_tnv_credited = true WHERE id = p_match_id;
  ELSE
    UPDATE matches SET p2_tnv_credited = true WHERE id = p_match_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'earnedTnv', v_earned);
END;
$$;

-- 9. mark_match_settled (idempotent one-time winner payout flag)
CREATE OR REPLACE FUNCTION public.mark_match_settled(p_match_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  UPDATE public.matches SET settled_at = now() WHERE id = p_match_id AND settled_at IS NULL;
  RETURN found;
END;
$function$;

-- 10. Ensure refund_queue table exists
CREATE TABLE IF NOT EXISTS public.refund_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  fee numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  tx_hash text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS refund_queue_status_created_idx
  ON public.refund_queue (status, created_at);

-- 11. Ensure user_rewards table has needed columns
ALTER TABLE public.user_rewards
  ADD COLUMN IF NOT EXISTS last_refund_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunds_today int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunds_today_wld numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunds_today_date date,
  ADD COLUMN IF NOT EXISTS cancellations_hour int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancellations_hour_at timestamptz;

-- 12. Ensure matches table has needed columns
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS p1_payment_tx_hash text,
  ADD COLUMN IF NOT EXISTS p2_payment_tx_hash text,
  ADD COLUMN IF NOT EXISTS p1_tnv_credited boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS p2_tnv_credited boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tie boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz,
  ADD COLUMN IF NOT EXISTS p1_last_roll_at timestamptz,
  ADD COLUMN IF NOT EXISTS p2_last_roll_at timestamptz;

-- 13. Grant execute permissions
GRANT EXECUTE ON FUNCTION public.join_or_create_match(text, numeric, text) TO anon;
GRANT EXECUTE ON FUNCTION public.secure_start_match(uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.secure_leave_waiting_match(uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.secure_roll_dice(uuid, text, int4) TO anon;
GRANT EXECUTE ON FUNCTION public.secure_complete_match(uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.record_verified_payment(uuid, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.queue_refund_request(uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.secure_credit_tnv(uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.mark_match_settled(uuid) TO anon;

-- DONE: All critical functions are now at their latest hardened versions.
-- The join_or_create_match function uses the search-before-pay flow.
