-- ============================================================
-- admin_fee_log.sql
--
-- The house keeps 0.4 x entry fee per duel (pot 2*fee minus 1.6*fee
-- payout), collected on-chain in the escrow contract — but nothing
-- ever logged it, so the admin earnings panel always showed
-- "No fees collected". Log one ADMIN_FEE row per completed match.
-- The FOUND guard means only the first player's complete call
-- inserts (both players call secure_complete_match) — never duplicated.
-- ============================================================

create or replace function public.secure_complete_match(p_match_id uuid, p_wallet text)
returns jsonb
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
  v_fee numeric;
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'not_found'); END IF;
  IF v_match.p1_address IS DISTINCT FROM v_wallet AND v_match.p2_address IS DISTINCT FROM v_wallet THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_participant');
  END IF;

  -- 'matched' is finalized exactly like 'playing': a stuck matched
  -- match has 0-0 scores -> tie -> both players refunded.
  IF v_match.status IN ('playing','matched') THEN
    v_fee := COALESCE(v_match.fee, 0.5);
    IF v_match.p1_score > v_match.p2_score THEN
      v_winner_address := v_match.p1_address; v_winner_username := v_match.p1_username;
    ELSIF v_match.p2_score > v_match.p1_score THEN
      v_winner_address := v_match.p2_address; v_winner_username := v_match.p2_username;
    ELSE
      -- TIE: nobody wins; both players get their fee refunded.
      v_winner_address := 'tie'; v_winner_username := 'tie';
      v_payout := 0;
    END IF;

    v_payout := CASE v_fee
      WHEN 0.1 THEN 0.17 WHEN 0.2 THEN 0.34 WHEN 0.5 THEN 0.80 WHEN 1 THEN 1.60
      WHEN 2 THEN 3.20 WHEN 5 THEN 8.80 WHEN 10 THEN 17.8 WHEN 20 THEN 36.0
      WHEN 30 THEN 54.0 WHEN 40 THEN 72.0 WHEN 50 THEN 90.0
      ELSE ROUND(v_fee * 1.6, 2)
    END;

    UPDATE matches
    SET status = 'completed',
        winner_address = v_winner_address,
        winner_username = v_winner_username,
        payout_amount = v_payout,
        tie = (v_winner_address = 'tie')
    WHERE id = p_match_id AND status IN ('playing','matched');

    -- House fee (0.4 x entry fee) is kept on-chain in the escrow
    -- contract; record it so the admin earnings panel reflects real
    -- revenue. FOUND => only the first completer logs it.
    IF FOUND AND v_winner_address <> 'tie' THEN
      INSERT INTO match_history (wallet_address, action_type, amount, description, created_at)
      VALUES ('0x8FB70CDFb545C7D9b842cBE37B9aba84059Bf14b', 'ADMIN_FEE',
              ROUND(v_fee * 0.4, 2), 'House fee ' || v_fee || ' WLD duel', now());
    END IF;
  END IF;

  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  RETURN jsonb_build_object('success', true, 'match', to_jsonb(v_match));
END;
$$;
