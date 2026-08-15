-- =============================================================
-- Harden the refund/settle flow (run in Supabase SQL editor)
-- 1) settled_at column  -> idempotent winner payout
-- 2) queue_refund_request now validates the caller is a PAID
--    participant of a waiting match (prevents draining other
--    players' deposits via the public RPC)
-- 3) mark_match_settled RPC -> atomic one-time winner payout flag
-- =============================================================

alter table public.matches
  add column if not exists settled_at timestamptz;

-- -------------------------------------------------------------
-- Refund queue: only allow a refund request for a match where
-- the wallet is a participant who actually PAID, and the match
-- is still waiting/searching. Anything else is rejected.
-- -------------------------------------------------------------
create or replace function public.queue_refund_request(p_match_id uuid, p_wallet text)
returns jsonb
language plpgsql
security definer
as $function$
declare
  v_fee numeric;
  v_status text;
  v_p1 text;
  v_p2 text;
  v_p1_paid boolean;
  v_p2_paid boolean;
  v_wallet text := lower(trim(p_wallet));
begin
  select fee, status, p1_address, p2_address, p1_paid, p2_paid
    into v_fee, v_status, v_p1, v_p2, v_p1_paid, v_p2_paid
    from public.matches
   where id = p_match_id
   limit 1;

  if v_fee is null then
    return json_build_object('success', false, 'error', 'match not found');
  end if;

  -- Only an un-started match can be refunded.
  if v_status not in ('waiting', 'searching') then
    return json_build_object('success', false, 'error', 'match not refundable in status ' || coalesce(v_status, 'unknown'));
  end if;

  -- The wallet must be a participant AND must have actually paid.
  if v_wallet = lower(v_p1) and v_p1_paid then
    null; -- ok
  elsif v_wallet = lower(v_p2) and v_p2_paid then
    null; -- ok
  else
    return json_build_object('success', false, 'error', 'wallet is not a paid participant of this match');
  end if;

  -- Refund queue mein insert karo
  insert into public.refund_queue (match_id, wallet_address, fee, status)
  values (p_match_id, v_wallet, v_fee, 'pending');

  return json_build_object('success', true);
exception when others then
  return json_build_object('success', false, 'error', SQLERRM);
end;
$function$;

-- -------------------------------------------------------------
-- One-time winner payout flag. Returns true ONLY if this call
-- was the first to claim the match (so a duplicate settle call
-- can never pay the winner twice).
-- -------------------------------------------------------------
create or replace function public.mark_match_settled(p_match_id uuid)
returns boolean
language plpgsql
security definer
as $function$
begin
  update public.matches
     set settled_at = now()
   where id = p_match_id
     and settled_at is null;
  return found;
end;
$function$;
