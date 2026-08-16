-- ============================================================
-- CLOSE DRAIN HOLES — payment / refund / TNV
--
-- Problem: force_confirm_payment was anon-executable and set
-- p1_paid/p2_paid with NO payment proof. Anyone could create a
-- match, mark themselves paid, queue a refund, and drain the
-- escrow balance. TNV could also be farmed infinitely by calling
-- secure_credit_tnv repeatedly on the same match.
--
-- Fixes:
--   1. New columns: per-player verified payment tx hashes,
--      per-player TNV-credited flags, tie flag.
--   2. record_verified_payment(): the ONLY way to mark a player
--      paid — requires participant + payable match state + a
--      payment tx hash that is not already used by another match.
--   3. force_confirm_payment(): neutralized — can only grant paid
--      status if a verified payment hash is already recorded.
--   4. queue_refund_request(): refunds require the player's
--      verified payment hash; ties (completed+tie) are refundable.
--   5. secure_complete_match(): equal scores -> tie (winner='tie',
--      tie=true) so no one silently loses their fee.
--   6. secure_credit_tnv(): completed status + paid participant +
--      one-time credit per player per match.
-- ============================================================

alter table public.matches
  add column if not exists p1_payment_tx_hash text,
  add column if not exists p2_payment_tx_hash text,
  add column if not exists p1_tnv_credited boolean not null default false,
  add column if not exists p2_tnv_credited boolean not null default false,
  add column if not exists tie boolean not null default false;

-- ============ 2. record_verified_payment ============
-- Called by the verify-payment edge function AFTER the payment was
-- proven on-chain. Grants paid status atomically with the tx hash.
create or replace function public.record_verified_payment(
  p_match_id uuid,
  p_wallet text,
  p_tx_hash text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet text := lower(trim(p_wallet));
  v_tx text := lower(trim(p_tx_hash));
  v_row public.matches;
  v_is_p1 boolean;
begin
  if v_tx is null or length(v_tx) < 10 then
    return json_build_object('success', false, 'error', 'invalid tx hash');
  end if;

  select * into v_row from public.matches where id = p_match_id for update;
  if not found then
    return json_build_object('success', false, 'error', 'match not found');
  end if;

  if v_row.status not in ('waiting', 'matched', 'searching') then
    return json_build_object('success', false, 'error', 'match not in payable state: ' || coalesce(v_row.status, 'null'));
  end if;

  if lower(coalesce(v_row.p1_address, '')) = v_wallet then
    v_is_p1 := true;
  elsif lower(coalesce(v_row.p2_address, '')) = v_wallet then
    v_is_p1 := false;
  else
    return json_build_object('success', false, 'error', 'wallet is not a participant');
  end if;

  -- One payment can never pay for two different matches.
  if exists (
    select 1 from public.matches
    where (p1_payment_tx_hash = v_tx or p2_payment_tx_hash = v_tx)
      and id <> p_match_id
  ) then
    return json_build_object('success', false, 'error', 'tx hash already used for another match');
  end if;

  if v_is_p1 then
    update public.matches
      set p1_paid = true, p1_payment_tx_hash = v_tx
      where id = p_match_id;
  else
    update public.matches
      set p2_paid = true, p2_payment_tx_hash = v_tx
      where id = p_match_id;
  end if;

  return json_build_object('success', true, 'player', case when v_is_p1 then 'p1' else 'p2' end);
end;
$$;

-- ============ 3. force_confirm_payment (neutralized) ============
-- Kept for backward compatibility, but it can no longer grant paid
-- status on its own: the player must already have a verified
-- payment hash recorded by record_verified_payment.
create or replace function public.force_confirm_payment(
  p_match_id uuid,
  p_is_p1 boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.matches;
begin
  select * into v_row from public.matches where id = p_match_id;
  if not found then return; end if;

  if p_is_p1 then
    if v_row.p1_payment_tx_hash is not null then
      update public.matches set p1_paid = true where id = p_match_id;
    end if;
  else
    if v_row.p2_payment_tx_hash is not null then
      update public.matches set p2_paid = true where id = p_match_id;
    end if;
  end if;
end;
$$;

-- ============ 4. queue_refund_request (hardened) ============
-- A refund is only queued for a player whose payment was VERIFIED
-- on-chain (payment tx hash recorded), and only for pre-game
-- matches or ties. The resolver re-verifies on-chain before paying.
create or replace function public.queue_refund_request(
  p_match_id uuid,
  p_wallet text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
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
begin
  select fee, status, p1_address, p2_address, p1_paid, p2_paid,
         p1_payment_tx_hash, p2_payment_tx_hash, tie
    into v_fee, v_status, v_p1, v_p2, v_p1_paid, v_p2_paid,
         v_p1_tx, v_p2_tx, v_tie
    from public.matches
   where id = p_match_id
   limit 1;

  if v_fee is null then
    return json_build_object('success', false, 'error', 'match not found');
  end if;

  -- Refundable: pre-game (waiting/searching/cancelled) OR a completed
  -- tie (equal scores — both players get their fee back).
  if v_status not in ('waiting', 'searching', 'cancelled') then
    if not (v_status = 'completed' and coalesce(v_tie, false)) then
      return json_build_object('success', false, 'error', 'match not refundable in status ' || coalesce(v_status, 'unknown'));
    end if;
  end if;

  -- The wallet must be a participant, must have PAID, and the payment
  -- must have been verified on-chain (a recorded tx hash). No tx hash
  -- means no on-chain proof -> no refund (kills fake-payment drains).
  if v_wallet = lower(v_p1) and v_p1_paid and v_p1_tx is not null then
    null; -- ok
  elsif v_wallet = lower(v_p2) and v_p2_paid and v_p2_tx is not null then
    null; -- ok
  else
    return json_build_object('success', false, 'error', 'wallet is not a verified paid participant of this match');
  end if;

  insert into public.refund_queue (match_id, wallet_address, fee, status)
  values (p_match_id, v_wallet, v_fee, 'pending');

  return json_build_object('success', true);
exception when others then
  return json_build_object('success', false, 'error', SQLERRM);
end;
$$;

-- ============ 5. secure_complete_match (tie) ============
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

  IF v_match.status = 'playing' THEN
    IF v_match.p1_score > v_match.p2_score THEN
      v_winner_address := v_match.p1_address; v_winner_username := v_match.p1_username;
    ELSIF v_match.p2_score > v_match.p1_score THEN
      v_winner_address := v_match.p2_address; v_winner_username := v_match.p2_username;
    ELSE
      -- TIE: nobody wins; both players get their fee refunded. A tie
      -- is marked explicitly so refunds are allowed for this match.
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

-- ============ 6. secure_credit_tnv (hardened) ============
-- Only a COMPLETED match, only a PAID participant, and only ONCE per
-- player per match (p1_tnv_credited / p2_tnv_credited flags) — TNV
-- can no longer be farmed by repeating the call.
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
