# Real authentication (SIWE) — what must be done, and what could not be verified

This documents the work needed to replace the current pretend-authentication
with a real Supabase session, so that Row Level Security can actually protect
per-user data. **Read the "Not verified" section before trusting any of it.**

## Why the current design cannot be secured

`app.js` treats a wallet address in `localStorage` as identity:

```js
localStorage.setItem("myAddress", myAddress);
```

There is no Supabase Auth session anywhere in the app. Consequences, all
confirmed against the live project:

1. **`matches` and `user_rewards` are readable by anyone** holding the
   publishable key from the client bundle — every wallet address, every
   balance. `Content-Range: 0-1/2` on `user_rewards` means *all* rows, not a page.
2. **RLS cannot fix it.** With no authenticated identity there is no
   `auth.uid()` to filter on, so the only policies permissive enough for the
   app to read its own row are equally permissive for everyone else.
3. Every admin RPC (`admin_get_cheaters`, `admin_get_revenue`,
   `admin_get_daily_revenue`, `admin_get_tickets`, `admin_get_alerts`) takes
   the admin wallet as a *parameter* and compares it to a hardcoded literal.
   Verified live: passing the address that ships in `app.js` returns **HTTP
   200**. Anyone can read admin data.

No amount of SQL closes #3 without a real identity, which is why this step
comes before the phase-2 lockdown.

## The intended flow

```
MiniKit.commandsAsync.walletAuth({ nonce, statement, ... })
        │  returns { address, message, signature }   ← a SIWE message
        ▼
supabase.auth.signInWithWeb3({ chain: 'ethereum', message, signature })
        ▼
a real Supabase session  →  auth.uid()  →  RLS works
```

Per Supabase's docs, `signInWithWeb3` accepts either a wallet provider or a
**raw `message` + `signature` pair** — so the absence of `window.ethereum`
inside World App is *not* a blocker on its own.

## Steps that require the Supabase dashboard (I cannot do these)

1. **Authentication → Providers → enable Web3 / Ethereum.**
2. **Authentication → URL Configuration → Redirect URLs:** add the Mini App's
   sign-in URL. Supabase validates the SIWE message's URI/domain against this
   list, so a mismatch fails the sign-in. MiniKit's generated message uses the
   app's own URL — confirm the exact value it emits and allowlist that.
3. If the app will not be served from a stable origin, add a wildcard pattern
   such as `https://your-app.vercel.app/**` (or `localhost` for dev).

## Deciding the RLS key — inspect before trusting

Supabase documents the wallet address as the Web3 *identity identifier*, but it
does **not** publish it as a JWT claim, and `auth.uid()` is a UUID, not the
address. So do not write `auth.jwt() ->> 'address'` on faith.

After these steps and one successful sign-in, run this in the browser console
and read the actual token before choosing a policy:

```js
const { data } = await supabaseClient.auth.getSession();
const jwt = data.session.access_token;
console.log(JSON.parse(atob(jwt.split('.')[1])));
```

Then pick one:

- **`sub` is a UUID and there is no address claim** → use the mapping table
  already created by `additive_secure_read_apis.sql`:

  ```sql
  -- populated ONLY by trusted server code after verifying the signature
  SELECT * FROM public.wallet_accounts WHERE user_id = auth.uid();
  ```

  Policy shape:

  ```sql
  CREATE POLICY "wallet owners read their rows"
    ON public.user_rewards FOR SELECT TO authenticated
    USING (
      lower(wallet_address) = (
        SELECT lower(w.address) FROM public.wallet_accounts w
         WHERE w.user_id = (SELECT auth.uid()) LIMIT 1
      )
    );
  ```

- **A verified address claim exists** (note its exact key first, e.g.
  `wallet_address`) → either use it directly, or add a Custom Access Token Hook
  so it is guaranteed to be present.

Either way `wallet_accounts` must be populated from a **verified** signature,
never from client-supplied input. Never let the client insert its own mapping.

## Not verified — treat as unconfirmed

These could not be checked from this workspace, and I have not guessed:

- **That the wallet address appears in the issued JWT at all**, or under which
  key. Inspect a real token before any policy depends on it.
- **That `MiniKit.commandsAsync.walletAuth` (the v1 API this app uses) returns
  `message` and `signature`**, not just `address`. The v2 docs show
  `MiniKit.walletAuth` returning `{ address, message, signature }`. **This app
  loads MiniKit 1.9.6 from a CDN while `package.json` declares `^2.0.3` — that
  mismatch must be resolved**, and the actual v1.9.6 payload logged and
  inspected before wiring it to Supabase.
- **That Supabase accepts a MiniKit-produced SIWE message.** The URI/domain must
  match the allowlist, and Supabase's timing window is 10 minutes.
- **Nonce replay protection.** World's guidance is that *you* verify the nonce
  server-side; Supabase's published validation does not promise this. If that
  matters for your threat model, verify it in your own backend.
- **That any of this works inside World App** — none of it can be exercised
  outside World App, and it has not been.

## Also missing

Sign-in currently 404s: the client calls `secure_ensure_user_row`, which is
defined in **no** SQL file. `full_security_lockdown.sql` even GRANTs it
(`GRANT EXECUTE ON FUNCTION public.secure_ensure_user_row(text, text)`), which
proves that file never completed — everything after that GRANT is unapplied.
`additive_secure_read_apis.sql` creates the missing function.

Several RPCs are defined in the repo but **absent from the live database**,
so those features silently fail today:

| RPC | Live result | Feature affected |
|---|---|---|
| `get_leaderboard` | 404 | Ranks tab shows fallback pseudonyms |
| `get_public_stats` | 404 | More tab Live Stats shows zeros |
| `admin_get_withdraw_requests` | 404 | Admin withdrawals panel |
| `secure_ensure_user_row` | not defined anywhere | Sign-in |
