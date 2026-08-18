-- ============================================================
-- APPLY MISSING RPCs
-- Run this in Supabase Dashboard → SQL Editor → RUN
-- ============================================================

-- 1. get_refund_status (used by app.js support bot)
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
  select exists (
    select 1 from public.matches m
    where m.id = p_match_id
      and (lower(m.p1_address) = v_wallet or lower(m.p2_address) = v_wallet)
  ) into v_is_participant;

  if not coalesce(v_is_participant, false) then
    return jsonb_build_object('found', false, 'error', 'not a participant of this match');
  end if;

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

-- 2. get_user_rewards (for balance display)
create or replace function public.get_user_rewards(p_wallet text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet text := lower(trim(p_wallet));
  v_row record;
begin
  select wld_balance, tnv_balance, total_games, games_played, games_won
    into v_row
    from public.user_rewards
   where wallet_address = v_wallet
   limit 1;

  if not found then
    return jsonb_build_object(
      'found', false,
      'wld_balance', 0, 'tnv_balance', 0,
      'total_games', 0, 'games_played', 0, 'games_won', 0
    );
  end if;

  return jsonb_build_object(
    'found', true,
    'wld_balance', coalesce(v_row.wld_balance, 0),
    'tnv_balance', coalesce(v_row.tnv_balance, 0),
    'total_games', coalesce(v_row.total_games, 0),
    'games_played', coalesce(v_row.games_played, 0),
    'games_won', coalesce(v_row.games_won, 0)
  );
end;
$$;

grant execute on function public.get_user_rewards(text) to anon, authenticated;
