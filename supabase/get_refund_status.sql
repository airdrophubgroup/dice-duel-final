-- ============================================================
-- get_refund_status.sql
--
-- refund_queue intentionally has NO public RLS policy (only the
-- resolver's service key reads it), so the support bot in app.js
-- could not check whether a payment was already refunded. This
-- SECURITY DEFINER function lets a wallet read ONLY its own refund
-- row for a given match — it never exposes other players' data.
-- Returns the single latest refund row, or an empty set.
-- ============================================================

create or replace function public.get_refund_status(p_match_id uuid, p_wallet text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet text := lower(trim(p_wallet));
  v_row record;
  v_is_participant boolean;
begin
  -- Only participants of this match may query it.
  select exists (
    select 1 from public.matches m
    where m.id = p_match_id
      and (lower(m.p1_address) = v_wallet or lower(m.p2_address) = v_wallet)
  ) into v_is_participant;

  if not coalesce(v_is_participant, false) then
    return jsonb_build_object('found', false, 'error', 'not a participant of this match');
  end if;

  -- Priority: a 'done' refund is the definitive answer (money already
  -- returned). Only fall back to the latest row when no 'done' exists,
  -- so an older success is never masked by a later failed retry row.
  select rq.status, rq.tx_hash, rq.fee, rq.error, rq.created_at
    into v_row
    from public.refund_queue rq
   where rq.match_id = p_match_id
     and lower(rq.wallet_address) = v_wallet
   order by (case when rq.status = 'done' then 0 else 1 end), rq.created_at desc
   limit 1;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'status', v_row.status,
    'tx_hash', v_row.tx_hash,
    'fee', v_row.fee,
    'error', v_row.error,
    'created_at', v_row.created_at
  );
end;
$$;

grant execute on function public.get_refund_status(uuid, text) to anon, authenticated;
