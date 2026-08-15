# 🎲 Dice Duel — WLD Mini App

Real-time PvP dice duel that runs inside the **World App** (Worldchain). Players pay a WLD entry fee, get matched 1v1, and the winner takes the pot.

## How it works

1. **Matchmaking** — `join_or_create_match` creates a `waiting` match or joins you to an open one at the same fee tier.
2. **Payment** — the player sends the entry fee (WLD) via MiniKit directly to the escrow contract. `/api/record-deposit` verifies the transfer **on-chain** (never trusts MiniKit's status) and marks `p1_paid` / `p2_paid` in Supabase, which is the ledger of record.
3. **Play** — when both players have paid, the match starts; dice rolls are server-validated via `secure_roll_dice` (15 turns each).
4. **Settlement** — the winner's device calls `/api/refund-match` (SETTLE_WINNER). The API validates the winner against the Supabase match row and pays the displayed payout (pot minus house cut) via the contract's owner-only `emergencyTokenTransfer`.
5. **Refund** — if a match is cancelled or times out (60 s no opponent), `queue_refund_request` enqueues a refund; the `refund-resolver` edge function (every 1 min via pg_cron) sends the WLD back.

## Architecture notes

- The deployed escrow contract (`TnvDuelArena`, `0x2f9D3bC7...`) has **no `recordDeposit` function** and its `joinMatch` (Permit2) path enforces a 5-minute cancel wait, which conflicts with the game's 1-minute auto-refund requirement. The app therefore treats the contract as a WLD holding wallet: **Supabase is the match ledger**, and all payouts/refunds go through owner-operated `emergencyTokenTransfer`.
- All Supabase writes go through **SECURITY DEFINER RPCs** that validate participants/payment server-side. Direct table access (anon key) is restricted to reads via RLS — see `supabase/harden_refund_flow.sql` and `supabase/cleanup_audit.sql`.

## Files

| Path | Purpose |
|---|---|
| `index.html`, `app.js`, `style.css` | Frontend (vanilla ES modules, MiniKit + Supabase from CDN) |
| `api/record-deposit.js` | On-chain WLD payment verification |
| `api/refund-match.js` | Validated refund / winner-payout API |
| `supabase/functions/refund-resolver/index.ts` | Cron-driven refund processor (deployed as Supabase Edge Function) |
| `supabase/harden_refund_flow.sql` | Refund-queue validation + one-time settle flag |
| `supabase/cleanup_audit.sql` | One-time cleanup: orphan tables/functions/columns, RLS fix |

## Deploy

- **Vercel**: connected to GitHub — push to `main` auto-deploys. Env vars on Vercel: `OPERATOR_PRIVATE_KEY` (the escrow contract owner), `SUPABASE_URL`, `SUPABASE_ANON_KEY` (optional; falls back to the publishable key).
- **Supabase Edge Function**: `supabase functions deploy refund-resolver --no-verify-jwt`, secrets `OPERATOR_PRIVATE_KEY`, `DICE_DUEL_CONTRACT`, `CRON_SECRET`. pg_cron calls it every minute with the `x-cron-secret` header.
