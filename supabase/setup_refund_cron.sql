-- ============================================================
-- RUN THIS IN: Supabase Dashboard → SQL Editor → New Query → RUN
-- ============================================================
-- This sets up the AUTOMATIC REFUND cron job.
-- After running, refunds will process automatically within 1 minute.
-- ============================================================

-- Step 1: Enable required extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Step 2: Schedule the refund-resolver edge function every minute
-- IMPORTANT: Replace YOUR_CRON_SECRET below with the actual secret
-- you set earlier. If you never set one, run this in the Dashboard's
-- Edge Functions → refund-resolver → Secrets:
--   CRON_SECRET = <any long random string>

select cron.schedule(
  'refund-resolver-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://efmkazyrxllcyvcwmewd.supabase.co/functions/v1/refund-resolver',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'YOUR_CRON_SECRET'
    ),
    body := '{}'
  );
  $$
);

-- DONE! Refunds will now process automatically within 1 minute of being queued.
-- To verify: check the refund_queue table — rows should change from 'pending' to 'done' quickly.
