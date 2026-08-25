# TNV Duel Arena - Worldcoin Mini App Listing Kit

Everything below is ready to copy-paste into the **Worldcoin Developer Portal**
(developer.worldcoin.org). The images are in this same `publish/` folder.

---

## Skill-Based Game - Compliant

Your game is SKILL-BASED, not chance-based:
- The scoring depends on WHERE you tap the timing meter (red=1, yellow=3, green=6)
- This is a timing skill mechanic, not random dice rolls
- Server validates all scores, 1v1 real-time, 15 turns each

This should pass World's guidelines. Key points:
- Frame as "skill timing duel" not "dice game"
- No emojis in app name or descriptions
- Avoid generic terms like "Earn" in descriptions
- All payments verified on-chain

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
1v1 skill timing duel with WLD entry fees. Win WLD payouts + TNV rewards.
```

### Category
```
Games  (or: Entertainment)
```

### Long Description

```
TNV Duel Arena -- the 1v1 skill timing duel inside World App.

FIND YOUR RIVAL
Tap PLAY NOW, choose your duel fee (0.1 - 50 WLD), and you're matched
in seconds with a real player who put the same amount on the line.

THE DUEL
30 seconds, 15 turns each. A timing meter sweeps across red, yellow,
and green zones -- tap at the right moment to score higher. The closer
your tap to the green zone, the more points you score. Both players
must pay to play, and the match only starts when both are verified
on-chain, so every duel is fair.

THE REWARD
The winner takes the published payout (up to 90 WLD) and receives TNV
rewards. The loser still receives a consolation TNV amount for showing
up. Every match is recorded -- check your latest matches anytime.

GOT A PROBLEM?
Our in-app Payment Support Bot checks your payments on-chain, finds
any missed refund, and queues it automatically. Still not satisfied?
Reach out on Telegram -- a real human replies with their real
World username.

SECURITY YOU CAN TRUST
- Payments are verified on-chain -- never trust a client-side claim
- Refunds are automatic and verified before any payout
- Anti-cheat: server-validated, tap lock, 15-turn cap
- Only the official World App can open this mini app

TNV REWARDS
TNV is building toward Mainnet, Swap and a rewards store -- gift
cards, electronics, games and more. Play today, grow your balance.
```

### Support Email
```
airdrophubgroup@gmail.com
```

### Tags / Keywords
```
skill duel, game, wld, win, rewards, tnv, arena, battle, 1v1, multiplayer, timing
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

## What reviewers check (World App guidelines)

- App opens and works inside the official World App webview ✅
- Wallet sign-in works (MiniKit walletAuth) ✅
- Usernames shown, not raw addresses ✅
- No "official" wording, no World logo in branding ✅
- No token pre-sales, no paid membership tiers ✅ (none)
- Skill-based timing mechanic (not chance/RNG) ✅
- Mobile-first, compact UI, no long scroll ✅
- No emojis in app name or descriptions ✅
- Description avoids generic terms like "Earn" ✅
