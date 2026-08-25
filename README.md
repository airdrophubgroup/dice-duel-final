<div align="center">

# 🎲 Dice Duel — TNV Duel Arena

**Real-time 1v1 dice battles inside the World App.** Stake WLD, get matched at the same fee tier, roll 15 dice each in a 32-second round — highest score takes the pot. Winner gets **WLD + TNV**, loser still gets **TNV consolation**.

> ✨ **Floating animated guide — rules, winner logic & security:** open [`about.html`](about.html) in any browser.

</div>

---

## ⚡ At a Glance

| Feature | Status |
|---|---|
| 🎮 1v1 real-time matchmaking (server-verified) | ✅ Live |
| 💳 WLD entry fees — 0.1 to 50 WLD (11 tiers) | ✅ Live |
| 🏆 Exact winner payouts, TNV rewards both sides | ✅ Live |
| 🔄 Auto-refund within 60 seconds | ✅ Live |
| 🛡️ On-chain payment verification + anti-drain | ✅ Live |
| 💬 Global community chat (realtime presence) | ✅ Live |
| 🏅 TNV leaderboard + withdrawals (min 5,000 TNV) | ✅ Live |
| 📜 Match history — latest 10, auto-prune | ✅ Live |
| 🤖 Payment Support Bot (tx-hash guide + auto-refund) | ✅ Live |
| 🤝 Agent airdrophubgroup — human support tickets | ✅ Live |
| 🛡️ Auto security monitor — bug checks every 5 min | ✅ Live |
| 💎 TNV Ecosystem — Mainnet, Swap, Store, Tournaments | 🔜 Soon |
| 💰 TNV Winnings view (all 11 bet tiers) | ✅ Live |
| 🛡️ Admin Dashboard (Revenue · Withdrawals · Tickets) | ✅ Live |
| ⏱️ 32s match timer (2s connect + 30s play) | ✅ Live |

---

## 🎮 How It Works

1. **Pick your stake** — entry fee from **0.1 WLD** up to **50 WLD**. Higher stake = bigger pot.
2. **Get matched** — paired 1v1 with a player at the same fee tier. Matchmaking is **server-validated** and only pairs you after your payment is confirmed on-chain.
3. **Roll 15 times** — a **32-second round** (30s gameplay + 2s result). One roll every 2 seconds — **15 taps per player**.
4. **Highest score wins** — the winner gets the exact displayed payout; the platform cut stays with the house. Ties are void: **both players refunded, no payout**.

### 🏆 Winner Payouts (exact, server-set)

| Entry | Winner Gets | | Entry | Winner Gets |
|---|---|---|---|---|
| 0.1 WLD | **0.17 WLD** | | 10 WLD | **17.80 WLD** |
| 0.2 WLD | **0.34 WLD** | | 20 WLD | **36.00 WLD** |
| 0.5 WLD | **0.80 WLD** | | 30 WLD | **54.00 WLD** |
| 1 WLD | **1.60 WLD** | | 40 WLD | **72.00 WLD** |
| 2 WLD | **3.20 WLD** | | 50 WLD | **90.00 WLD** |
| 5 WLD | **8.80 WLD** | | | |

### 💎 TNV Rewards (winner full · loser ⅓ consolation)

| Entry | Winner | Loser | | Entry | Winner | Loser |
|---|---|---|---|---|---|---|
| 0.1 | +5 | +1 | | 10 | +250 | +83 |
| 0.2 | +10 | +3 | | 20 | +500 | +166 |
| 0.5 | +15 | +5 | | 30 | +750 | +250 |
| 1 | +25 | +8 | | 40 | +1,000 | +333 |
| 2 | +50 | +16 | | 50 | +1,250 | +416 |
| 5 | +125 | +41 | | | | |

---

## 🛡️ Security & Fairness

- **On-chain payment verification** — the World App's status is never trusted. Every payment is verified against the **real WLD transfer**, and the transfer must postdate the match (no stale/reused payments).
- **Server-validated dice** — every roll is checked server-side: value 1–6, 15-turn cap, participant-only, turn-lock. Client-side hacking can't change scores.
- **Validated refunds & payouts** — only a **paid participant** of the exact match can receive money; amounts come from the database, never the client.
- **One-time settlement** — atomic completion + credited flags make **double payouts, double TNV and double refunds impossible**.
- **Anti-drain protection** — unpaid strangers can't queue refunds; duplicate tx-hashes are globally rejected (1 payment = 1 match).
- **Tie = void match** — equal scores mean both players get their entry fee back; nobody earns TNV (no farming vector).
- **Auto-refund within 60s** — cancel, or no opponent in 60s → a cron resolver returns your WLD in ~1 minute.
- **Ghost cleanup** — abandoned/stale waiting matches are detected and auto-cleaned; no dead matches to match into.
- **Admin-gated operations** — withdrawals and blocks only by the verified admin wallet; every admin RPC rejects strangers.
- **RLS-protected data** — direct writes are blocked; every state change goes through validated security-definer functions.

---

## 🤖 Agent airdrophubgroup

- **Payment Support Bot** — scans your matches, detects paid-but-unrefunded games, queues your refund automatically, and teaches you how to find your transaction hash step by step (copy address → worldscan.org → copy hash → verify).
- **Human Agent handoff** — not satisfied? Talk to **Agent airdrophubgroup**. The agent listens empathetically, verifies your account step by step (matches, payments, refunds, tickets), then creates a support ticket.
- **Admin replies with their real username** — the admin answers from the admin panel; you see the reply in the bot with the admin's **real Worldcoin username**.
- **Already refunded?** — paste any tx-hash; the bot detects reused/fake hashes and shows you your refund proof with a copy button.

## 🛡️ Auto Security Monitor

Runs **every 5 minutes** with zero manual work and watches 6 categories:

| Check | Severity |
|---|---|
| Refunds stuck > 5 min | 🔴 Critical |
| Failed refunds | 🔴 Critical |
| Stale waiting matches (ghosts) | 🟡 Warning |
| Games stuck mid-play | 🟡 Warning |
| Completed matches missing TNV | 🟡 Warning |
| Auto-clicker detections | 🟡 Warning |

Findings land in the **admin alert panel** — deduplicated, so the same issue never floods the log.

---

## 📜 Match History

- Users see their **latest 10 matches** — opponent, fee, W/L + payout, scores and time.
- Older matches are **automatically deleted from the server** (completed only; refund-pending matches are never touched).
- **Admin sees everything** — all withdrawal requests (with status badges) and all collected fees (no limits).

---

## 💎 TNV Ecosystem (coming soon)

Floating on the home screen: **Gift Cards · Electronics · Video Games · Toys · Shopping** — plus SOON tiles for:

- 🚀 **TNV Mainnet**
- 🔄 **TNV Swap**
- 🛍️ **TNV Store** — redeem TNV for real products
- 🎮 **Tournaments**

---

## 🚀 Deploy

- **Hosting** — connect the repository to Vercel; pushing to `main` auto-deploys. Environment variables: operator key, Supabase URL, Supabase anon key.
- **Refund resolver** — the cron-driven refund processor runs as a Supabase Edge Function (invoked every minute) with its own secrets.
- **Auto monitor** — scheduled directly in the database (every 5 minutes); no extra setup needed after the initial script runs.

---

## 📋 Recent Changes (August 2025)

### 🔧 Security & Bug Fixes
- **RLS withdraw fix** — `withdraw_requests` table had DENY ALL RLS; replaced 4 direct client reads with secure SECURITY DEFINER RPCs (`get_my_withdraw_requests`, `admin_get_withdraw_requests`). Home tab now shows withdrawal status.
- **Cancelled-match refund fix** — `record_verified_payment` now accepts the `cancelled` state so late-verified payments can queue refunds (prevents stranded funds).
- **Self-spam guard** — `join_or_create_match` prevents one wallet from flooding the waiting pool with duplicate rows.
- **Admin panel visibility** — CSS `!important` guard class now toggled via classList (not inline styles), so admin panels actually show for the admin.
- **Bottom-half blank screen fix** — empty `<main>` with `flex:1` consumed half the viewport; now hidden unless `body.game-active`.

### ✨ New Features
- **TNV Winnings** — More tab tile shows all 11 bet tiers with Win/Lose TNV rewards.
- **Admin Dashboard** — 3-tab modal: Revenue (daily ledger), Withdrawals (all requests with approve), Tickets (agent support replies).
- **Home Withdrawal Status** — see your pending/approved withdrawal requests directly on the Home tab.
- **Play Tab Green Win Amount** — each fee chip displays the exact WLD winner payout in green (+0.17 to +90).
- **Live Stats Card** — real-time Withdraw Requests, Agent Messages, Total Matches, Online Players (privacy-safe aggregate RPC).
- **Tab Switch Animation** — lightweight 22ms slide-fade for smoother tab transitions.
- **Cache-Control Headers** — Vercel serves index.html/app.js/style.css with `max-age=0` so updates are never stale.

### 🧪 Regression Tests
- **`test/payout-tiers.test.cjs`** — 23 automated checks: all 11 bet tiers cross-verified (client ↔ API ↔ SQL), tie rules, TNV win/lose rewards. Run: `node test/payout-tiers.test.cjs`

### 📦 SQL Migrations to Run
1. `supabase/unified_latest_migration.sql` — core functions (matchmaking, game, settlement, refunds)
2. `supabase/missing_withdraw_admin_functions.sql` — withdrawal submit/approve + admin block
3. `supabase/withdraw_read_rpcs.sql` — user/admin withdrawal reads
4. `supabase/public_stats_rpc.sql` — privacy-safe live stats aggregate

All use `CREATE OR REPLACE` — safe to re-run.

---

<div align="center">

**Made for the Worldcoin ecosystem** — fair, verifiable, and always protected. 🎲

</div>
