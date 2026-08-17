-- ============================================================
-- PRUNE USER MATCH HISTORY — keep only the latest 10 per user
--
-- The match history modal shows a user's latest 10 matches.
-- Everything older (for the SAME wallet) is deleted from the
-- matches table so the database never grows unbounded and the
-- history view stays instant on low-end phones.
--
-- SAFETY:
--   * Only status='completed' matches are pruned (settled games).
--     Waiting / playing / cancelled matches are never touched.
--   * A match that still has a refund_queue row is NEVER deleted
--     (refund_queue.match_id -> matches.id ON DELETE CASCADE would
--     silently destroy a pending/paid refund). Tie matches keep
--     their refund rows until the resolver pays them, so they stay
--     in history — that is correct: money first, cleanup later.
--   * The latest 10 matches (by created_at) are always kept.
-- ============================================================

create or replace function public.prune_user_matches(p_wallet text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet text := lower(p_wallet);
  v_deleted int;
begin
  delete from public.matches m
  where (m.p1_address = v_wallet or m.p2_address = v_wallet)
    and m.status = 'completed'
    and m.id not in (
      select id from public.matches
      where p1_address = v_wallet or p2_address = v_wallet
      order by created_at desc
      limit 10
    )
    and not exists (
      select 1 from public.refund_queue rq
      where rq.match_id = m.id
    );

  get diagnostics v_deleted = row_count;
  return jsonb_build_object('success', true, 'deleted', v_deleted);
end;
$$;

grant execute on function public.prune_user_matches(text) to anon, authenticated;
