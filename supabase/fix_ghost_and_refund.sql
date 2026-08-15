-- =============================================================
-- FIX: ghost waiting matches + refund race
--  1. queue_refund_request: allow refunds for cancelled matches too
--     (a paid participant refunding a match that was just cancelled
--      is the normal case — the security gate stays: the wallet must
--      be a paid participant).
--  2. join_or_create_match: only join waiting matches younger than
--     90s, so a ghost/abandoned match can never be joined.
--  3. Clean up current ghost rows.
-- =============================================================

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

  -- Refundable while waiting, searching, or already cancelled (the
  -- cancel flow marks the match cancelled and then queues the refund —
  -- a strict 'waiting' check raced and lost against that status update).
  if v_status not in ('waiting', 'searching', 'cancelled') then
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

  insert into public.refund_queue (match_id, wallet_address, fee, status)
  values (p_match_id, v_wallet, v_fee, 'pending');

  return json_build_object('success', true);
exception when others then
  return json_build_object('success', false, 'error', SQLERRM);
end;
$function$;

-- Only join waiting matches that were created recently (within 90s).
-- A match older than that is either about to be auto-cancelled (the app
-- times out at 60s) or a ghost left behind by a player who closed the app.
create or replace function public.join_or_create_match(p_address text, p_fee numeric, p_username text)
returns setof matches
language plpgsql
security definer
as $function$
declare
  v_match public.matches;
  v_clean_address text := lower(trim(p_address));
begin
  select * into v_match
  from public.matches
  where status = 'waiting'
    and fee = p_fee
    and p1_paid = true
    and lower(trim(p1_address)) != v_clean_address
    and created_at > now() - interval '90 seconds'
  order by created_at asc
  limit 1
  for update skip locked;

  if found then
    update public.matches
    set p2_address = v_clean_address,
        p2_username = p_username,
        p2_paid = false
    where id = v_match.id
    returning * into v_match;

    return next v_match;
  else
    insert into public.matches (
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
    )
    values (
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
    returning * into v_match;

    return next v_match;
  end if;
end;
$function$;

-- Clean up the current ghosts (one is a refunded waiting match, the
-- other an unpaid cancelled match — no money affected).
update public.matches set status = 'cancelled'
 where status = 'waiting'
   and p2_paid = false
   and created_at < now() - interval '2 minutes';
