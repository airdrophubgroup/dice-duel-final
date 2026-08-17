-- ============================================================
-- refund_idempotent_fix.sql
--
-- BUG FOUND under load testing: queue_refund_request only relied on
-- the partial unique index refund_queue_one_live_per_player, which
-- only guards (pending, processing) rows. Once the resolver marks a
-- row 'done', a SECOND call for the same match+wallet inserts a NEW
-- pending row -> the resolver tries to refund AGAIN. On a real paid
-- match the first refund already left the contract, so the second
-- attempt fails ("Insufficient contract balance") and leaves a
-- scary failed row; with a large contract balance it could have
-- double-refunded. Now queue_refund_request is fully idempotent:
-- if ANY row exists for (match_id, wallet_address) - pending,
-- processing, done OR failed - it returns success without inserting.
-- ============================================================

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
  v_existing uuid;
  v_wallet text := lower(trim(p_wallet));
begin
  -- Fully idempotent: if ANY refund row already exists for this
  -- player+match (queued, in-flight, completed, or even failed), do
  -- NOT insert another. A retry/cancel/bot re-run can never create a
  -- second payout. 'failed' is treated as existing so a previously
  -- failed row isn't silently re-inserted by a later duplicate call;
  -- the resolver's own recovery paths handle real failures.
  select id into v_existing
    from public.refund_queue
   where match_id = p_match_id
     and wallet_address = v_wallet
   limit 1;
  if v_existing is not null then
    return json_build_object('success', true, 'already_queued', true);
  end if;

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
