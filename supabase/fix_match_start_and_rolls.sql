-- ============================================================
-- FIX 1: Match never starts.
-- join_or_create_match never set status='matched' when player 2
-- joined, and secure_start_match only transitions 'matched' ->
-- 'playing'. So checkBothReady (app) never fired -> game never
-- started, even with both players paid.
--
-- Now:
--   * p2 join  -> status becomes 'matched' (two players present)
--   * secure_start_match -> requires status='matched' AND both
--     p1_paid AND p2_paid before flipping to 'playing' (the user
--     rule: only when BOTH have paid do the players connect and
--     the battle begin).
-- ============================================================

create or replace function public.join_or_create_match(
  p_address text,
  p_fee numeric,
  p_username text
) returns setof public.matches
language plpgsql
security definer
set search_path = public
as $$
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
    -- Second player joined: mark the match 'matched' so the app's
    -- readiness poll can see it. The match does NOT start until
    -- both players have paid (secure_start_match below enforces).
    update public.matches
    set p2_address = v_clean_address,
        p2_username = p_username,
        p2_paid = false,
        status = 'matched'
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
$$;

-- Start only when BOTH players have paid and the match is 'matched'.
create or replace function public.secure_start_match(
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
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'not_found'); END IF;
  IF v_match.p1_address IS DISTINCT FROM v_wallet AND v_match.p2_address IS DISTINCT FROM v_wallet THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_participant');
  END IF;
  IF v_match.status = 'matched' THEN
    IF NOT coalesce(v_match.p1_paid, false) OR NOT coalesce(v_match.p2_paid, false) THEN
      RETURN jsonb_build_object('success', false, 'error', 'both_players_must_pay');
    END IF;
    UPDATE matches SET game_started = true, status = 'playing', start_time = now() WHERE id = p_match_id;
    RETURN jsonb_build_object('success', true, 'status', 'playing');
  END IF;
  IF v_match.status = 'playing' AND v_match.game_started THEN
    RETURN jsonb_build_object('success', true, 'status', 'playing');
  END IF;
  RETURN jsonb_build_object('success', false, 'error', 'match_not_ready');
END;
$$;

-- ============================================================
-- FIX 2: secure_roll_dice accepted ANY p_roll (e.g. 999999999),
-- so a player could inflate their score infinitely -> guaranteed
-- win -> payout drain. Now the server is authoritative:
--   * p_roll must be an integer between 1 and 6
--   * rounds are capped at 60 seconds from start_time
--   * at least 1 second must pass between a player's own rolls
--     (anti rapid-fire spam)
--   * existing 15-turn cap stays
-- ============================================================

alter table public.matches
  add column if not exists p1_last_roll_at timestamptz,
  add column if not exists p2_last_roll_at timestamptz;

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
    current_taps := coalesce(m.p1_taps_used, 0);
    current_score := coalesce(m.p1_score, 0);
    last_roll := m.p1_last_roll_at;
  elsif lower(m.p2_address) = lower(p_wallet) then
    is_p1 := false;
    current_taps := coalesce(m.p2_taps_used, 0);
    current_score := coalesce(m.p2_score, 0);
    last_roll := m.p2_last_roll_at;
  else
    return json_build_object('success', false, 'error', 'Unauthorized player');
  end if;

  if current_taps >= max_taps then
    return json_build_object('success', false, 'error', 'Max turns exceeded');
  end if;

  -- Anti rapid-fire: at least 1s between this player's own rolls.
  if last_roll is not null and now() - last_roll < interval '1 second' then
    return json_build_object('success', false, 'error', 'Roll too fast');
  end if;

  if is_p1 then
    update public.matches
    set p1_score = current_score + p_roll,
        p1_taps_used = current_taps + 1,
        p1_last_roll_at = now()
    where id = p_match_id;
  else
    update public.matches
    set p2_score = current_score + p_roll,
        p2_taps_used = current_taps + 1,
        p2_last_roll_at = now()
    where id = p_match_id;
  end if;

  return json_build_object('success', true, 'new_score', current_score + p_roll, 'taps_left', max_taps - (current_taps + 1));
end;
$$;

-- ============================================================
-- FIX 3: secure_leave_waiting_match only cancelled status
-- 'waiting'. After FIX 1 a joined (but not yet started) match is
-- 'matched' — cancel must still work before the game starts.
-- Money safety is unchanged: queue_refund_request still requires
-- a PAID participant, so an unpaid cancel produces no refund row.
-- ============================================================

create or replace function public.secure_leave_waiting_match(
  p_match_id uuid,
  p_wallet text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update matches
  set status = 'cancelled'
  where id = p_match_id
    and (p1_address = p_wallet or p2_address = p_wallet)
    and status in ('waiting', 'matched')
    and coalesce(game_started, false) = false;
end;
$$;
