-- ============================================================
-- cancel_refund_fix.sql
--
-- 1) record_verified_payment: a payment verified ON-CHAIN must be
--    recorded even when the match is already 'cancelled'. The user can
--    pay, then cancel while verification is still in flight; without
--    this, paid stays false, the refund can never be queued and the
--    WLD sits in the escrow contract forever. The real security gate is
--    the on-chain proof (only verify-payment, after scanning World
--    Chain, calls this RPC) plus the tx-hash dedupe below — NOT the
--    match status.
--
-- 2) queue_refund_request: idempotent. Multiple code paths (cancel,
--    background booking, resolver maintenance) may call it for the same
--    player + match; without a dedupe, duplicate pending rows would be
--    paid out twice. Now a live row (pending/processing) short-circuits
--    to success.
--
-- 3) refund_queue unique index: backstop so no second live row can
--    ever exist for the same player + match.
-- ============================================================

create or replace function public.record_verified_payment(p_match_id uuid, p_wallet text, p_tx_hash text)
returns json
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

  if v_row.status not in ('waiting', 'matched', 'searching', 'cancelled') then
    return json_build_object('success', false, 'error', 'match not in payable state: ' || coalesce(v_row.status, 'null'));
  end if;

  if lower(coalesce(v_row.p1_address, '')) = v_wallet then
    v_is_p1 := true;
  elsif lower(coalesce(v_row.p2_address, '')) = v_wallet then
    v_is_p1 := false;
  else
    return json_build_object('success', false, 'error', 'wallet is not a participant');
  end if;

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

create or replace function public.queue_refund_request(p_match_id uuid, p_wallet text)
returns jsonb
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

  if v_status not in ('waiting', 'searching', 'cancelled') then
    if not (v_status = 'completed' and coalesce(v_tie, false)) then
      return json_build_object('success', false, 'error', 'match not refundable in status ' || coalesce(v_status, 'unknown'));
    end if;
  end if;

  if v_wallet = lower(v_p1) and v_p1_paid and v_p1_tx is not null then
    null; -- ok
  elsif v_wallet = lower(v_p2) and v_p2_paid and v_p2_tx is not null then
    null; -- ok
  else
    return json_build_object('success', false, 'error', 'wallet is not a verified paid participant of this match');
  end if;

  -- Idempotent: never double-queue the same player's refund. A second
  -- call for the same match + wallet returns success (already queued).
  if exists (
    select 1 from public.refund_queue
    where match_id = p_match_id and wallet_address = v_wallet
      and status in ('pending', 'processing')
  ) then
    return json_build_object('success', true, 'already_queued', true);
  end if;

  insert into public.refund_queue (match_id, wallet_address, fee, status)
  values (p_match_id, v_wallet, v_fee, 'pending');

  return json_build_object('success', true);
exception when others then
  return json_build_object('success', false, 'error', SQLERRM);
end;
$$;

-- Backstop: at most one live refund row per player per match.
drop index if exists refund_queue_one_live_per_player;
create unique index refund_queue_one_live_per_player
  on public.refund_queue (match_id, wallet_address)
  where status in ('pending', 'processing');
