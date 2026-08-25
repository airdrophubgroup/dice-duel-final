-- ============================================================
-- PUBLIC STATS RPC — privacy-safe live stats
--
-- Guideline fix: the More tab's Live Stats card previously read
-- withdraw_requests / support_tickets rows DIRECTLY with the anon
-- key. Depending on RLS state this either leaked other users'
-- wallet addresses + amounts, or silently returned nothing.
--
-- This RPC exposes ONLY aggregate counts — no wallet addresses,
-- no amounts, no usernames. Safe for any visitor.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_public_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_withdraw_total int;
  v_withdraw_pending int;
  v_tickets_total int;
  v_tickets_open int;
  v_matches_total bigint;
BEGIN
  SELECT count(*)::int,
         count(*) FILTER (WHERE status = 'pending')::int
    INTO v_withdraw_total, v_withdraw_pending
    FROM public.withdraw_requests;

  SELECT count(*)::int,
         count(*) FILTER (WHERE status IN ('pending', 'open'))::int
    INTO v_tickets_total, v_tickets_open
    FROM public.support_tickets;

  SELECT count(*) INTO v_matches_total FROM public.matches;

  RETURN jsonb_build_object(
    'withdrawTotal', coalesce(v_withdraw_total, 0),
    'withdrawPending', coalesce(v_withdraw_pending, 0),
    'ticketsTotal', coalesce(v_tickets_total, 0),
    'ticketsOpen', coalesce(v_tickets_open, 0),
    'matchesTotal', coalesce(v_matches_total, 0)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'withdrawTotal', 0, 'withdrawPending', 0,
    'ticketsTotal', 0, 'ticketsOpen', 0, 'matchesTotal', 0
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_public_stats() TO anon;
