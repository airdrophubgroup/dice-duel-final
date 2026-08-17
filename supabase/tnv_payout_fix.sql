-- ============================================================
-- TNV PAYOUT FIX
-- 1) TIE MATCHES MUST NOT CREDIT TNV
--    Rules: winner gets the full tier reward, defeat gets 1/3
--    consolation. A TIE is a void match (both players refunded)
--    — it has no winner and no loser, so it must earn 0 TNV.
--    Before this fix, secure_credit_tnv treated a tie as a
--    "defeat" for BOTH players and silently credited each one
--    floor(base/3) TNV, even though the app popup says
--    "Equal scores — refunded" and shows no TNV. That was both
--    rule-wrong and a TNV-farming vector (colluding players can
--    force ties repeatedly).
-- 2) MISSING user_rewards ROW
--    If the player row is missing, the UPDATE touched 0 rows but
--    the per-match credited flag was still set — the TNV was
--    permanently lost. Now the row is upserted first.
-- ============================================================

create or replace function public.secure_credit_tnv(
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
  v_is_p1 boolean;
  v_is_win boolean;
  v_tnv_base int;
  v_earned int;
  v_updated int;
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'not_found'); END IF;
  IF v_match.p1_address IS DISTINCT FROM v_wallet AND v_match.p2_address IS DISTINCT FROM v_wallet THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_participant');
  END IF;

  IF v_match.status <> 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'match_not_completed');
  END IF;

  -- A tie is a void match: both players get their entry fee back
  -- and NOBODY earns TNV (no winner, no defeat).
  IF v_match.tie OR v_match.p1_score = v_match.p2_score THEN
    RETURN jsonb_build_object('success', false, 'error', 'tie_match_no_tnv');
  END IF;

  v_is_p1 := (v_match.p1_address = v_wallet);
  IF v_is_p1 AND NOT coalesce(v_match.p1_paid, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'player_not_paid');
  END IF;
  IF NOT v_is_p1 AND NOT coalesce(v_match.p2_paid, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'player_not_paid');
  END IF;

  -- One-time credit per player per match.
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

  -- Make sure the player row exists BEFORE crediting — otherwise the
  -- UPDATE would touch 0 rows and the credited flag would still be set
  -- (TNV permanently lost).
  INSERT INTO user_rewards (wallet_address, tnv_balance, total_games, games_played, games_won)
  SELECT v_wallet, 0, 0, 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM user_rewards WHERE wallet_address = v_wallet);

  UPDATE user_rewards
  SET tnv_balance = COALESCE(tnv_balance, 0) + v_earned,
      total_games = COALESCE(total_games, 0) + 1,
      games_played = COALESCE(games_played, 0) + 1,
      games_won = COALESCE(games_won, 0) + (CASE WHEN v_is_win THEN 1 ELSE 0 END)
  WHERE wallet_address = v_wallet;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'credit_failed');
  END IF;

  IF v_is_p1 THEN
    UPDATE matches SET p1_tnv_credited = true WHERE id = p_match_id;
  ELSE
    UPDATE matches SET p2_tnv_credited = true WHERE id = p_match_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'earnedTnv', v_earned);
END;
$$;

-- keep anon able to call it (same as before)
grant execute on function public.secure_credit_tnv(uuid, text) to anon, authenticated;
