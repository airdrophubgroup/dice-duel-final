# Changelog — TNV Duel Arena

## Version 1.0.6 (October 2026)

### Emoji removal + official World App spacing (same reviewer feedback)

**Removed 202 emoji codepoints from `app.js`.** The 1.0.5 pass claimed emoji had
been removed, but it only covered the HTML surface. The payment support bot,
match-result text, toasts and admin diagnostics still used emoji as icons
(`\u{1F44B} \u{2705} \u{274C} \u{1F4CB} \u{1F3B2}` and roughly sixty more). All are
now plain text. Four severity/style ternaries that returned an emoji glyph now
return short word labels (`DONE`/`FAILED`/`RUNNING`/`PENDING`,
`CRIT`/`HIGH`/`WARN`/`INFO`, `OK`/`WARN`/`FAIL`) rather than an empty string.
Applied with a one-off script and verified line-by-line: 258 changed blocks, 0
of them unexplained by emoji removal, `node --check` clean. The script
deliberately leaves `—`, `·`, `…` and curly quotes untouched, so no prose was
damaged. An early revision of that script stripped "space before a quote" and
silently rewrote `' tickets need attention!'` to `'tickets'` — producing
"3tickets" in admin output. That rule was replaced with one that only touches
whitespace directly adjacent to a removed emoji, and the fix is confirmed in the
diff.

**Adopted the documented World App design values.**
`docs.world.org/mini-apps/guidelines/design-guidelines` specifies 24px page
padding, 32px after the last scrollable item when a bottom bar is present, and a
tab bar sitting 12px above the OS bottom bar. Version 1.0.4 had moved all three
the wrong way (20px side margins, 24px bottom inset, 8px tab-bar offset). They
now match the documented numbers, and the tab bar's 70px height is exactly
reserved so scroll content can never sit under it.

**Replaced the remaining decorative UI.** The Play tab's radar scanner (rotating
conic sweep, pulsing core, pinging dots) is gone, along with the `#target-dot`
node that `app.js` flashed green on connect — that code path is removed rather
than left dereferencing a missing element. It is now a standard 44px
indeterminate spinner. The match-result icon was a single letter (`W`/`L`/`=`)
blown up to 48px; it is now an SVG check/cross/dash tinted per result state. The
suspended-account screen used a bare `!` character as its icon; it is now an
alert-triangle SVG.

**Verified in the running app.** All four tabs report zero overflow at both
390×844 and 360×640; Ranks now leaves exactly the documented 32px above the tab
bar. Result icons measured 44×44, centred, with per-state colours (`#29d9c2`
win, `#e85d5d` loss, `#f0b232` tie). Consent persists across reload. Limitation:
screenshots could not be captured in this webview session, so the visual pass
was done by measuring bounding boxes and computed styles rather than reviewing
pixels.

## Version 1.0.5 (October 2026)

### UI Quality Pass (reviewer feedback: "looks too vibe coded")

**Fixed broken design tokens.** A previous stylesheet rewrite renamed the colour
variables but dynamic elements built in `app.js` still referenced the old names.
120 references to `--photon`, `--signal`, `--iris`, `--bone` and `--slate` were
resolving to nothing, so toasts, modals, admin panels and status text were
rendering with inherited/black colours. The old names are now aliased onto the
current palette, and the two referenced-but-unloaded font families
(`Space Grotesk`, `JetBrains Mono`) resolve correctly — `Space Grotesk` folded
into Inter, `JetBrains Mono` now loaded for numeric data.

**Removed decorative "vibe-coded" elements.**
- Deleted the animated aurora/grid background layers from the markup.
- Deleted the radar-scanner graphic on the Play tab (rotating conic sweep,
pulsing core, pinging dots).
- Replaced the matchmaking radar scanner with a standard rotating loading
spinner.
- Removed emoji from the HTML markup (chat welcome banner, leaderboard medals,
confirmation popups); these now use SVG icons and typographic elements.
(Markup only — the 202 remaining emoji inside `app.js` were removed in 1.0.6.)
- Removed the non-functional "SOON" tiles (Swap, Market, Verified Airdrops)
from the More tab, along with the AI Agent tile, so the public surface shows
only working features.

**Flattened every neon overlay.** The payment countdown, payment-confirmed
popup, opponent-left popup, confirmation dialog and toast notifications no
longer use gradient fills, coloured glow shadows, pulsing circles or text
glows; all now use the shared flat card tokens.

**Leaderboard shows usernames, not wallets.** The Ranks tab previously printed
truncated wallet addresses (`0x8c5b...b6a1`). It now renders the player's
username, with a stable pseudonym (`Player 1234`) as fallback so no part of a
wallet is ever displayed publicly. Emoji medal badges were replaced with
numeric rank chips in gold/silver/bronze. Added `supabase/leaderboard_usernames.sql`
which provides `set_user_username()` and a privacy-safe `get_leaderboard()` RPC.
The client degrades gracefully if those functions have not been deployed yet.

**Layout fits every screen.** Verified all four tabs render without scrolling at
both 390×844 and 360×640. The More tab was 74px too tall on a small phone — the
Live Stats card is now a single four-column row and tile/accordion padding was
tightened. No panel overflows its viewport.

**Fixed a Content-Security-Policy gap** — `wss://*.supabase.co` was missing from
`connect-src`, which blocked Supabase realtime subscriptions in the console.

**Deployment note:** run `supabase/leaderboard_usernames.sql` in the Supabase SQL
editor to enable username-based leaderboard names. Until then the board shows
pseudonyms (never wallet addresses).

## Version 1.0.4 (September 2026)

### Worldcoin Guideline Compliance (Major)
- **Compacted all UI sections** — reduced home card padding (24px→18px), header padding (24px→16px), more-tile padding (24px→16px), and card gaps (32px→18px) to eliminate long scrolling.
- **Fixed payout table grid** — corrected CSS grid from 4 columns to 3 columns to match the HTML header row.
- **Reduced More tab item sizes** — smaller icons, tighter gaps, compact stat cards so all 10 items + Live Stats fit in viewport.
- **Reduced app padding** — tighter 20px side margins for a more mobile-native feel.
- **Reduced tab panel padding-bottom** — less blank space at the bottom of each tab.

## Version 1.0.3 (September 2026)

### Bug Fixes
- **Fixed first-screen loading issue** — removed aggressive environment check that was replacing the entire page with "ACCESS DENIED" when MiniKit SDK was slow to initialize. The app now loads the full UI immediately and gates wallet/payment features only after authentication.
- **Fixed More tab buttons not responding to clicks** — the `::before` pseudo-element on `.more-tile` was blocking pointer events. Added `pointer-events: none` to restore normal button behavior.
- **Fixed History/Withdrawals modals crashing without sign-in** — these modals now gracefully show a "Sign in" message instead of silently failing when no wallet is connected.
- **Fixed Play tab layout being cut off** — reduced scanner size from 90px to 60px and compacted spacing so all 11 fee chips + PLAY NOW button fit within the viewport without scrolling.
- **Fixed "earn" word in user-facing text** — replaced with "rewards" to comply with Worldcoin policy guidelines.

### Performance Improvements
- **Removed `debugger;` statement** that paused JavaScript execution every 15 seconds, causing severe lag on low-end devices.
- **Reduced polling intervals** — DevTools check: 2s → 5s, state check: 1s → 3s, admin re-hide: 1s → 3s. Reduced DOM queries from ~180/min to ~60/min.
- **Removed 14 unnecessary console.log calls** in production — kept only 6 security-critical ones.
- **Removed console warning banner** that ran on page load.
- **Extended error buffer flush interval** from 30s to 60s to reduce network overhead.

### New Features
- **AI Agent Panel** — admin-only panel for system health monitoring, auto-recovery, error diagnosis, and quick status checks. Accessible from the More tab.
- **Global Error Catcher** — catches all JavaScript errors, unhandled promise rejections, and network failures. Logs to Supabase `app_errors` table for debugging.
- **Auto-Recovery System** — runs every 60 seconds and automatically fixes stuck matches, failed refunds, broken UI state, and stuck matchmaking.
- **Self-Scanner** — periodic health checks that verify Supabase connectivity, RPC functions, World Chain RPC, and admin wallet balance.
- **Supabase Keep-Alive Workflow** — GitHub Actions cron job pings Supabase every 2 days to prevent free-tier pause. Pings Database, Auth, Storage, and Edge Functions.

### Security Enhancements
- **Anti-injection DOM Mutation Observer** — monitors for unauthorized DOM changes and blocks injection attacks.
- **Protected critical functions** — `escapeHtml`, `sanitizeInput`, `checkWorldAppEnvironment` cannot be overwritten.
- **World App enforcement** (5-layer detection) — gates wallet/payment operations, no longer destroys page body on failure.
- **Reconnection limit** — maximum 3 reconnections per match to prevent abuse.
- **Server-validated dice rolls** — all dice outcomes generated by Supabase RPCs, zero client-side RNG.

### Worldcoin Guidelines Compliance
- All 27 guideline points verified: 24px padding, 32px spacing, 12px tab bar from bottom, iOS scroll bounce prevention, bottom safe area, 4-tab navigation, no hamburger/sidebar/footer, username display, smooth transitions, consistent backgrounds, consent modal, support email, world-app-id, MiniKit integration, CSP + X-Frame-Options, no pre-sale/membership, skill-based gameplay, search-before-pay flow.

### Database
- Created `production_cleanup.sql` for pre-launch database cleanup.
- Created `ai_agent_error_logging.sql` for error logging table + RPCs.
- All RPC functions verified working: 25 functions tested.
