-- ============================================================
-- CONCURRENCY / STUCK-MATCH FIX
-- secure_complete_match only finalized status='playing' matches.
-- If a match was stuck in 'matched' (one device died before
-- secure_start_match, or the start RPC failed), finalizing did
-- NOTHING -> the match stayed 'matched' forever and both players'
-- WLD stayed locked in escrow.
--
-- Now a 'matched' match finalizes exactly like a 'playing' one.
-- A stuck 'matched' match has no server-accepted rolls (rolls are
-- rejected unless status='playing'), so scores are 0-0 -> the tie
-- branch marks it tie and BOTH paid players get auto-refunded.
-- ============================================================

create or replace function public.secure_complete_match(
  p_match_id uuid,
  p_wallet text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  -- 'matched' is finalized exactly like 'playing': a stuck matched
  -- match has 0-0 scores -> tie -> both players refunded.
  IF v_match.status IN ('playing','matched') THEN
    IF v_match.p1_score > v_match.p2_score THEN
      v_winner_address := v_match.p1_address; v_winner_username := v_match.p1_username;
    ELSIF v_match.p2_score > v_match.p1_score THEN
      v_winner_address := v_match.p2_address; v_winner_username := v_match.p2_username;
    ELSE
      -- TIE: nobody wins; both players get their fee refunded.
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
    WHERE id = p_match_id AND status IN ('playing','matched');
  END IF;

  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  RETURN jsonb_build_object('success', true, 'match', to_jsonb(v_match));
END;
$$;

grant execute on function public.secure_complete_match(uuid, text) to anon, authenticated;

-- ============================================================
-- CONCURRENCY / LOST-ROLL FIX
-- secure_roll_dice read the score into a local variable and then
-- wrote it back (`p1_score = current_score + p_roll`). Two rolls
-- arriving at the same instant both read the same old score, and the
-- second write overwrote the first -> a roll was silently LOST (wrong
-- score, wrong taps count). Under heavy concurrency (hundreds of
-- players) that race was real.
--
-- Now the update is ATOMIC: the arithmetic runs on the CURRENT column
-- value inside the UPDATE, and the WHERE clause re-validates the tap
-- cap and the 1-second gap at write time. No roll can be lost and no
-- roll can bypass the rate limits under concurrent load.
-- ============================================================

create or replace function public.secure_roll_dice(
  p_match_id uuid,
  p_wallet text,
  p_roll int4
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  is_p1 boolean;
  current_taps int;
  current_score bigint;
  last_roll timestamptz;
  max_taps constant int := 15;
begin
  if p_roll is null or p_roll < 1 or p_roll > 6 then
    return json_build_object('success', false, 'error', 'Invalid roll (must be 1-6)');
  end if;

  select * into m from public.matches where id = p_match_id and status = 'playing';
  if not found then
    return json_build_object('success', false, 'error', 'Match not active');
  end if;

  -- Round window: no rolls after 60 seconds from match start.
  if m.start_time is not null and now() > m.start_time + interval '60 seconds' then
    return json_build_object('success', false, 'error', 'Round time expired');
  end if;

  if lower(m.p1_address) = lower(p_wallet) then
    is_p1 := true;
  elsif lower(m.p2_address) = lower(p_wallet) then
    is_p1 := false;
  else
    return json_build_object('success', false, 'error', 'Unauthorized player');
  end if;

  -- ATOMIC write: the score/taps arithmetic runs on the current column
  -- values and the WHERE clause re-checks the tap cap + 1s gap at write
  -- time, so concurrent rolls can never overwrite each other and can
  -- never bypass the rate limits.
  if is_p1 then
    update public.matches
    set p1_score = coalesce(p1_score, 0) + p_roll,
        p1_taps_used = coalesce(p1_taps_used, 0) + 1,
        p1_last_roll_at = now()
    where id = p_match_id
      and coalesce(p1_taps_used, 0) < max_taps
      and (p1_last_roll_at is null or now() - p1_last_roll_at >= interval '1 second');
  else
    update public.matches
    set p2_score = coalesce(p2_score, 0) + p_roll,
        p2_taps_used = coalesce(p2_taps_used, 0) + 1,
        p2_last_roll_at = now()
    where id = p_match_id
      and coalesce(p2_taps_used, 0) < max_taps
      and (p2_last_roll_at is null or now() - p2_last_roll_at >= interval '1 second');
  end if;

  if not found then
    return json_build_object('success', false, 'error', 'Roll rejected (too fast or max turns)');
  end if;

  if is_p1 then
    select p1_score, p1_taps_used into current_score, current_taps from public.matches where id = p_match_id;
  else
    select p2_score, p2_taps_used into current_score, current_taps from public.matches where id = p_match_id;
  end if;

  return json_build_object('success', true, 'new_score', current_score, 'taps_left', max_taps - current_taps);
end;
$$;

grant execute on function public.secure_roll_dice(uuid, text, int4) to anon, authenticated;
