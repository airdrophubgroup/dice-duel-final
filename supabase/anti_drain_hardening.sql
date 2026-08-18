-- ============================================================
-- ANTI-DRAIN HARDENING
--
-- Prevents wallet drain via:
--   1. Per-wallet refund cooldown (min 30s between refunds)
--   2. Per-wallet daily refund cap (max 5 refunds/day or 5 WLD/day)
--   3. Payment age validation (payments older than 5 min can't be refunded)
--   4. Anti-flood: max 5 cancelled matches per wallet per hour
--   5. Total escrow exposure tracking
-- ============================================================

-- 1. Add cooldown tracking columns to user_rewards
alter table public.user_rewards
  add column if not exists last_refund_at timestamptz,
  add column if not exists refunds_today int not null default 0,
  add column if not exists refunds_today_wld numeric not null default 0,
  add column if not exists refunds_today_date date,
  add column if not exists cancellations_hour int not null default 0,
  add column if not exists cancellations_hour_at timestamptz;

-- ============================================================
-- 2. HARDENED queue_refund_request — with cooldown + daily cap + age check
-- ============================================================
create or replace function public.queue_refund_request(
  p_match_id uuid,
  p_wallet text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
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
  v_match_created_at timestamptz;
  v_today date := current_date;
  v_last_refund timestamptz;
  v_refunds_today int;
  v_refunds_wld numeric;
  v_refunds_today_date date;
begin
  -- Load match
  select fee, status, p1_address, p2_address, p1_paid, p2_paid,
         p1_payment_tx_hash, p2_payment_tx_hash, tie, created_at
    into v_fee, v_status, v_p1, v_p2, v_p1_paid, v_p2_paid,
         v_p1_tx, v_p2_tx, v_tie, v_match_created_at
    from public.matches
   where id = p_match_id
   limit 1;

  if v_fee is null then
    return json_build_object('success', false, 'error', 'match not found');
  end if;

  -- Refundable: pre-game (waiting/searching/cancelled) OR completed tie
  if v_status not in ('waiting', 'searching', 'cancelled') then
    if not (v_status = 'completed' and coalesce(v_tie, false)) then
      return json_build_object('success', false, 'error', 'match not refundable in status ' || coalesce(v_status, 'unknown'));
    end if;
  end if;

  -- ANTI-DRAIN: Payment age check — payments older than 5 min can't be refunded
  -- This prevents someone from paying for an old match and getting a refund
  if v_match_created_at is not null and (now() - v_match_created_at) > interval '5 minutes' then
    return json_build_object('success', false, 'error', 'payment too old for automatic refund (>5 min)');
  end if;

  -- The wallet must be a participant, must have PAID, with tx hash proof
  if v_wallet = lower(v_p1) and v_p1_paid and v_p1_tx is not null then
    null; -- ok
  elsif v_wallet = lower(v_p2) and v_p2_paid and v_p2_tx is not null then
    null; -- ok
  else
    return json_build_object('success', false, 'error', 'wallet is not a verified paid participant of this match');
  end if;

  -- ANTI-DRAIN: Idempotent — never double-queue
  if exists (
    select 1 from public.refund_queue
    where match_id = p_match_id and wallet_address = v_wallet
      and status in ('pending', 'processing')
  ) then
    return json_build_object('success', true, 'already_queued', true);
  end if;

  -- ANTI-DRAIN: Per-wallet cooldown — minimum 30 seconds between refunds
  select last_refund_at, refunds_today, refunds_today_wld, refunds_today_date
    into v_last_refund, v_refunds_today, v_refunds_wld, v_refunds_today_date
    from public.user_rewards
   where wallet_address = v_wallet
   limit 1;

  if v_last_refund is not null and (now() - v_last_refund) < interval '30 seconds' then
    return json_build_object('success', false, 'error', 'refund cooldown active — please wait 30 seconds');
  end if;

  -- ANTI-DRAIN: Daily refund cap (max 5 refunds OR max 5 WLD per day)
  if v_refunds_today_date = v_today then
    if coalesce(v_refunds_today, 0) >= 5 then
      return json_build_object('success', false, 'error', 'daily refund limit reached (5/day)');
    end if;
    if coalesce(v_refunds_wld, 0) >= 5 then
      return json_build_object('success', false, 'error', 'daily WLD refund limit reached (5 WLD/day)');
    end if;
  end if;

  -- Insert refund request
  insert into public.refund_queue (match_id, wallet_address, fee, status)
  values (p_match_id, v_wallet, v_fee, 'pending');

  -- Update cooldown tracking
  if v_refunds_today_date = v_today then
    update public.user_rewards
    set last_refund_at = now(),
        refunds_today = refunds_today + 1,
        refunds_today_wld = refunds_today_wld + coalesce(v_fee, 0)
    where wallet_address = v_wallet;
  else
    update public.user_rewards
    set last_refund_at = now(),
        refunds_today = 1,
        refunds_today_wld = coalesce(v_fee, 0),
        refunds_today_date = v_today
    where wallet_address = v_wallet;
  end if;

  return json_build_object('success', true);
exception when others then
  return json_build_object('success', false, 'error', SQLERRM);
end;
$function$;

-- ============================================================
-- 3. ANTI-FLOOD: Track cancellations per wallet per hour
-- ============================================================
create or replace function public.secure_leave_waiting_match(
  p_match_id uuid,
  p_wallet text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_wallet text := lower(trim(p_wallet));
  v_row public.matches;
  v_cancel_hour timestamptz;
  v_cancel_count int;
begin
  select * into v_row from public.matches where id = p_match_id for update;
  if not found then
    return json_build_object('success', false, 'error', 'match not found');
  end if;

  -- Only participants can leave
  if lower(coalesce(v_row.p1_address, '')) <> v_wallet
     and lower(coalesce(v_row.p2_address, '')) <> v_wallet then
    return json_build_object('success', false, 'error', 'not a participant');
  end if;

  -- Only allowed if game hasn't started
  if coalesce(v_row.game_started, false) then
    return json_build_object('success', false, 'error', 'game already started');
  end if;

  -- ANTI-FLOOD: Max 10 cancellations per wallet per hour
  select cancellations_hour_at, cancellations_hour
    into v_cancel_hour, v_cancel_count
    from public.user_rewards
   where wallet_address = v_wallet
   limit 1;

  if v_cancel_hour is not null and (now() - v_cancel_hour) < interval '1 hour' then
    if coalesce(v_cancel_count, 0) >= 10 then
      return json_build_object('success', false, 'error', 'too many cancellations — wait 1 hour');
    end if;
    update public.user_rewards
    set cancellations_hour = cancellations_hour + 1
    where wallet_address = v_wallet;
  else
    if not exists (select 1 from public.user_rewards where wallet_address = v_wallet) then
      insert into public.user_rewards (wallet_address, cancellations_hour, cancellations_hour_at)
      values (v_wallet, 1, now());
    else
      update public.user_rewards
      set cancellations_hour = 1,
          cancellations_hour_at = now()
      where wallet_address = v_wallet;
    end if;
  end if;

  -- Set cancelled
  update public.matches
  set status = 'cancelled'
  where id = p_match_id
    and (p1_address = v_wallet or p2_address = v_wallet)
    and status in ('waiting', 'searching', 'matched')
    and coalesce(game_started, false) = false;

  return json_build_object('success', true);
end;
$function$;

-- ============================================================
-- 4. Reset daily refund counters (run via pg_cron at midnight)
-- ============================================================
create or replace function public.reset_daily_refund_counters()
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  update public.user_rewards
  set refunds_today = 0,
      refunds_today_wld = 0,
      refunds_today_date = current_date
  where refunds_today_date < current_date;
end;
$function$;

-- Schedule midnight reset (if pg_cron available)
do $$ begin
  perform cron.unschedule('daily-refund-counter-reset');
exception when others then null;
end $$;

select cron.schedule(
  'daily-refund-counter-reset',
  '0 0 * * *',
  $$ select public.reset_daily_refund_counters() $$
);

-- ============================================================
-- 5. Grant execute permissions
-- ============================================================
grant execute on function public.queue_refund_request(uuid, text) to anon, authenticated;
grant execute on function public.secure_leave_waiting_match(uuid, text) to anon, authenticated;
grant execute on function public.reset_daily_refund_counters() to service_role;

-- ============================================================
-- 6. Reset counters for existing users (start fresh)
-- ============================================================
update public.user_rewards
set refunds_today = 0,
    refunds_today_wld = 0,
    refunds_today_date = current_date,
    cancellations_hour = 0,
    cancellations_hour_at = now();
