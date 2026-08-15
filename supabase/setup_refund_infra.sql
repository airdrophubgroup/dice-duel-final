-- ============================================================================
-- Dice Duel — Automatic Refund Infrastructure (run in Supabase SQL editor)
-- Project ref: efmkazyrxllcyvcwmewd
--
-- Safe to re-run: everything uses IF NOT EXISTS / CREATE OR REPLACE.
--
-- How refunds work end-to-end:
--   1. The player pays the entry fee to the escrow contract via MiniKit.
--   2. app.js queues a refund (inserts a refund_queue row) when the search
--      is cancelled, the app is closed mid-search, or the 60s search timer
--      expires without an opponent.
--   3. A cron job runs every minute and calls the `refund-resolver` Edge
--      Function with the shared CRON_SECRET header.
--   4. refund-resolver verifies the match is still in "Waiting" on-chain
--      (player == p1) and calls cancelWaitingMatch(), which sends the WLD
--      back to the player.
--
-- IMPORTANT: refund-resolver looks the match up by id
-- (refund_queue.match_id -> matches.match_id) to rebuild the on-chain
-- bytes32 hash. So `matches` rows MUST NOT be deleted while a refund is
-- pending — see step 4 below.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. refund_queue — pending on-chain refunds processed by the cron job
-- ---------------------------------------------------------------------------
create table if not exists public.refund_queue (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  wallet_address text not null,
  fee numeric not null default 0, -- entry fee in WLD (matches.fee)
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'failed')),
  tx_hash text,
  error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists refund_queue_status_created_idx
  on public.refund_queue (status, created_at);

-- ---------------------------------------------------------------------------
-- 2. queue_refund_request(p_match_id, p_wallet) — called by app.js when the
--    player cancels the search or the 60s search timer expires.
--    SECURITY DEFINER so the anon/authenticated client can insert.
-- ---------------------------------------------------------------------------
create or replace function public.queue_refund_request(p_match_id uuid, p_wallet text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.refund_queue (match_id, wallet_address, fee)
  select m.id, lower(trim(p_wallet)), m.fee
    from public.matches m
   where m.id = p_match_id
  on conflict do nothing;
end;
$$;

grant execute on function public.queue_refund_request(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Schedule the refund-resolver Edge Function to run every minute.
--
--    First deploy the function (from the repo root):
--      supabase functions deploy refund-resolver --no-verify-jwt
--      supabase secrets set OPERATOR_PRIVATE_KEY=... \
--        DICE_DUEL_CONTRACT=0x2f9D3bC7125d563434cbc601b15Add6Ba0F3F3Db \
--        CRON_SECRET=some-long-random-string
--
--    Option A (RECOMMENDED): Supabase Dashboard -> Edge Functions -> Cron
--    -> Create job: function `refund-resolver`, schedule `* * * * *`, and
--    add a custom header  x-cron-secret: <CRON_SECRET> (same value you set
--    above). The dashboard handles auth automatically.
--
--    Option B: pg_cron + pg_net (enable both extensions in the dashboard,
--    then uncomment):
-- ---------------------------------------------------------------------------
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
--
-- select cron.schedule(
--   'refund-resolver-every-minute',
--   '* * * * *',
--   $$
--   select net.http_post(
--     url := 'https://efmkazyrxllcyvcwmewd.supabase.co/functions/v1/refund-resolver',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'x-cron-secret', '<CRON_SECRET>'
--     ),
--     body := '{}'
--   );
--   $$
-- );
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. secure_leave_waiting_match must NOT delete the match row.
--
--    If your current version deletes the row, refunds silently fail:
--    the queue row's FK dies (or the resolver can't look up
--    matches.match_id to rebuild the on-chain hash). Replace it with a
--    version that only marks the match cancelled, e.g.:
-- ---------------------------------------------------------------------------
-- create or replace function public.secure_leave_waiting_match(p_match_id uuid, p_wallet text)
-- returns void
-- language plpgsql
-- security definer
-- set search_path = public
-- as $$
-- begin
--   update public.matches
--      set status = 'cancelled'
--    where id = p_match_id
--      and status in ('waiting', 'searching')
--      and (p1_address = lower(p_wallet) or p2_address = lower(p_wallet));
-- end;
-- $$;
-- grant execute on function public.secure_leave_waiting_match(uuid, text) to anon, authenticated;
-- (adjust the status values to whatever your matchmaking RPCs use)

-- ---------------------------------------------------------------------------
-- 5. REQUEUE refunds that already failed with 'match not in Waiting state
--    on-chain'. Those rows mean the player paid but record-deposit never
--    booked the deposit, so the WLD is still in the contract. The updated
--    refund-resolver now returns such deposits via the owner-only
--    emergencyTokenTransfer (using matches.fee) — run this once AFTER
--    re-deploying the updated function:
-- ---------------------------------------------------------------------------
-- update public.refund_queue
--    set status = 'pending', error = null
--  where status = 'failed'
--    and error = 'match not in Waiting state on-chain';

-- ---------------------------------------------------------------------------
-- Notes:
--  * The `matches` table must already exist (created by your matchmaking
--    RPCs join_or_create_match / force_confirm_payment etc.).
--  * The updated refund-resolver only succeeds with the emergency refund
--    when OPERATOR_PRIVATE_KEY belongs to the contract owner. If it isn't
--    the owner, rows stay 'failed' and you must use the admin endpoint
--    api/emergengy-transfer.js to manually return the WLD.
--  * The fix for the root cause — record-deposit failing so matches never
--    get booked — is in api/record-deposit.js (re-deploy to Vercel).
-- ============================================================================
