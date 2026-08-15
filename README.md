# 🎲 Dice Duel — WLD PvP Mini App

**Real-time 1v1 dice battles inside the World App.** Players stake WLD, get matched at the same fee tier, roll 15 dice each in a 60-second round — and the highest score takes the pot.

> ✨ **Animated guide — rules, winner logic & security:** open **[`about.html`](about.html)** (or `https://<your-vercel-url>/about.html` once deployed).

---

## 🎮 How It Works

1. **Choose a stake** — entry fee from **0.1 WLD** to **50 WLD**.
2. **Get matched** — paired 1v1 with a player at the same fee tier (fresh matches only).
3. **Roll 15 times** — 60-second round, one roll every 2s. Rolls are **server-validated**.
4. **Highest score wins** — the pot (`2× fee`) is paid to the winner instantly; the house cut stays with the platform.

### Winner Payouts

| Entry | Winner Gets | House Cut |
|---|---|---|
| 0.1 WLD | 0.17 WLD | 15% |
| 0.2 WLD | 0.34 WLD | 15% |
| 0.5 WLD | 0.80 WLD | 20% |
| 1 WLD | 1.60 WLD | 20% |
| 2 WLD | 3.20 WLD | 20% |
| 5 WLD | 8.80 WLD | 12% |
| 10 WLD | 17.80 WLD | 11% |
| 20+ WLD | ~1.6–1.8× fee | ~10% |

Every match also awards **TNV points** (winner full tier reward, loser ⅓ consolation).

---

## 🔒 Security

- **On-chain payment verification** — MiniKit's status is never trusted; every payment is verified via the real WLD transfer, and the transfer must postdate the match (no stale/reused payments).
- **Server-validated dice** — rolls are checked server-side (1–6, 15-turn cap, participant-only). Client hacks can't change scores.
- **Validated refunds & payouts** — only a **paid participant** of the exact match can receive money; amounts come from the database, never the client.
- **RLS-protected database** — direct writes are blocked; every state change goes through validated SECURITY DEFINER RPCs.
- **One-time settlement** — atomic claim prevents double payouts.
- **Auto-refund within 60s** — cancel or no opponent in 60s → refund resolver returns your WLD in ~1 minute.
- **Ghost cleanup** — abandoned matches auto-cancel + auto-refund; no dead waiting matches.
- **Admin-gated ops** — withdrawals approved only by the verified admin wallet.

---

## 🏗️ Architecture

The escrow contract (`TnvDuelArena`, `0x2f9D3bC7…`) has no `recordDeposit` function and its `joinMatch`/Permit2 path enforces a 5-minute cancel wait — which conflicts with the game's 1-minute auto-refund rule. The app therefore treats the contract as a **WLD holding wallet**: **Supabase is the match ledger**, and all payouts/refunds go through owner-operated `emergencyTokenTransfer` (the same path the refund cron already uses).

| Path | Purpose |
|---|---|
| `index.html`, `app.js`, `style.css` | Frontend (vanilla ES modules, MiniKit + Supabase from CDN) |
| `about.html` | Animated rules / winner-logic / security page |
| `api/record-deposit.js` | On-chain WLD payment verification (anti-stale, time-checked) |
| `api/refund-match.js` | Validated refund / winner-payout API |
| `supabase/functions/refund-resolver/index.ts` | Cron-driven refund processor (Supabase Edge Function) |
| `supabase/harden_refund_flow.sql` | Refund-queue validation + one-time settle flag |
| `supabase/cleanup_audit.sql` | One-time cleanup: orphan tables/functions/columns, RLS fix |
| `supabase/fix_ghost_and_refund.sql` | Cancelled-match refunds, fresh-match pairing, ghost cleanup |

---

## 🚀 Deploy

- **Vercel** (connected to GitHub): push to `main` auto-deploys. Env vars: `OPERATOR_PRIVATE_KEY` (escrow owner), `SUPABASE_URL`, `SUPABASE_ANON_KEY` (optional fallback to publishable key).
- **Supabase Edge Function**: `supabase functions deploy refund-resolver --no-verify-jwt` with secrets `OPERATOR_PRIVATE_KEY`, `DICE_DUEL_CONTRACT`, `CRON_SECRET`. pg_cron invokes it every minute with the `x-cron-secret` header.
