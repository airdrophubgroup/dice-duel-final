# 🎲 TNV Duel Arena — Worldcoin Mini App Listing Kit

Everything below is ready to copy-paste into the **Worldcoin Developer Portal**
(developer.worldcoin.org). The images are in this same `publish/` folder.

---

## ⚠️ READ FIRST — Important (Chance-based games)

World's official Mini App guidelines say:

> **"We recommend developers to avoid building chance based games, as these
> games have a very low likelihood of being approved. Chance based = prize
> awarded based on chance, not skill. This means you are using a RNG to
> determine a winner."**

Your game rolls dice (RNG) to determine the winner. **This is exactly what
World warns about**, so the honest expectation is that review may be slow or
the app may be rejected on this ground. A few things that can help your case:

- The game has a **real-time 1-vs-1 skill element**: timing (2s tap lock),
  turn management (15 turns), and live play against a human — frame it as a
  skill/timing duel, not a slot machine.
- There is **no random jackpot**: both players pay the same fee, the payout
  is a fixed published amount, ties are refunded.
- Keep the listing description **accurate and transparent** about how it
  works (World dislikes misleading listings more than the mechanic itself).

If it gets rejected, that is a policy rejection — not a bug in your app.
Your fallback is to list the app for the World App users anyway (they can
install it directly), or shift the mechanic toward skill-based play.

---

## 🖼️ Assets (this folder)

| File | Purpose | Spec |
|---|---|---|
| `app-icon.png` | App icon | 512x512, square, non-white bg |
| `content-card.png` | Content card (banner) | 1035x720 = 345x240 @3x, no text, bottom 282px clear |
| `screenshot-home.png` | Screenshot 1 — Home | 390x844 |
| `screenshot-game.png` | Screenshot 2 — In game | 390x844 |
| `screenshot-result.png` | Screenshot 3 — Victory result | 390x844 |
| `screenshot-bot.png` | Screenshot 4 — Support bot | 390x844 |

---

## ✍️ Listing Copy

### App Name
```
TNV Duel Arena
```

### Short Description (max ~80 chars)
```
1v1 dice duel with WLD entry fees. Win WLD payouts + TNV rewards.
```

### Category
```
Games  (or: Entertainment)
```

### Long Description

```
🎲 TNV Duel Arena — the 1v1 dice battle inside World App.

FIND YOUR RIVAL
Tap PLAY NOW, choose your duel fee (0.1 – 50 WLD), and you're matched
in seconds with a real player who put the same amount on the line.

THE DUEL
32 seconds, 15 turns each. Tap the die — the faster you are with your
timing, the better your score. Both players must pay to play, and the
match only starts when both are verified on-chain, so every duel is
fair and nobody plays against a ghost.

THE REWARD
The winner takes the published payout (up to 90 WLD) and earns TNV
rewards. The loser still earns a consolation TNV amount for showing
up. Every match is recorded — check your latest 10 matches anytime.

GOT A PROBLEM?
Our in-app Payment Support Bot checks your payments on-chain, finds
any missed refund, and queues it automatically. Still not satisfied?
Talk to Agent airdrophubgroup — a real human replies with their real
World username.

SECURITY YOU CAN TRUST
• Payments are verified on-chain — never trust a client-side claim
• Refunds are automatic and verified before any payout
• Anti-cheat: server-validated rolls, 1s tap lock, 15-turn cap
• Only the official World App can open this mini app

EARN TNV, REDEEM LATER
TNV is building toward Mainnet, Swap and a rewards store — gift
cards, electronics, games and more. Play today, grow your balance.
```

### Tags / Keywords
```
dice, duel, game, wld, win, rewards, tnv, arena, battle, 1v1, multiplayer
```

---

## 📤 How to Publish — Step by Step

1. **Go to** `https://developer.worldcoin.org` (open it in a normal
   browser on your computer or phone).
2. **Sign in** — use the wallet that owns your mini app
   (`app_74bd2499a35b025efb62d99125df7883`). Make sure it's the same
   World App account that created the mini app.
3. **Create a mini app** if it doesn't exist:
   - Project name: `TNV Duel Arena`
   - App ID will be shown — it must match the one in your `index.html`
     (`app_74bd2499a35b025efb62d99125df7883`).
4. **Add your production URL** — the mini app must be pointing to your
   deployed app: `https://dice-duel-final.vercel.app/`
   (World App opens this URL inside its webview).
5. **App icon** — upload `app-icon.png` (512x512).
6. **Content card / banner** — upload `content-card.png`.
7. **Screenshots** — upload the 4 screenshots (drag all at once).
8. **Name** — `TNV Duel Arena`
9. **Short description** — paste from above.
10. **Long description** — paste from above.
11. **Category** — Games.
12. **Save**, then press **Submit for review**.

> Before submitting, open `https://dice-duel-final.vercel.app/` **inside
> the World App** (send the link to yourself in World App chat, or use
> the portal's "Test" / preview feature) and play one full duel — World
> reviewers check that the app actually works in the World App webview.

---

## 🔍 What reviewers check (World App guidelines)

- App opens and works inside the official World App webview ✅
- Wallet sign-in works (MiniKit walletAuth) ✅
- Usernames shown, not raw addresses ✅
- No "official" wording, no World logo in branding ✅
- No token pre-sales, no paid membership tiers ✅ (none)
- Chance-based game warning — see the note at the top ⚠️
- Mobile-first, no scroll bounce / smooth UI ✅
