# Blink Paywall server

The **hard paywall** backend for [Blink Paywall](../README.md). The widget's
soft mode unlocks in the browser and can be bypassed by anyone who opens
DevTools; this server keeps the locked content off the visitor's machine until
a Lightning payment is cryptographically verified, speaking the standard
[L402](https://docs.lightning.engineering/the-lightning-network/l402) protocol
("HTTP 402 Payment Required").

Zero dependencies, no database, **no Blink API key** — only your username.
Works for custodial Blink accounts and self-custodial (Spark) ones alike.

## Deploy

### Cloudflare Workers — free, about two minutes

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/blinkbitcoin/blink-paywall/tree/main/server)

The setup page asks for two values:

| | |
|---|---|
| `BLINK_USERNAME` | your Blink username — every payment lands in this account |
| `L402_ROOT_KEY` (secret) | 64 hex characters: `openssl rand -hex 32`. **Keep it.** A new key invalidates every unlock already sold. |

Cloudflare creates a copy of this folder in your GitHub account. Edit
`content.json` there and push: it redeploys. Your items live at
`https://<worker>.workers.dev/content/<id>`; open the Worker's URL for a demo
page that lists them with ready-to-copy snippets.

### Node — any VPS, Railway, Render, Fly, …

```bash
BLINK_USERNAME=you L402_ROOT_KEY=$(openssl rand -hex 32) node server/node.mjs
# open http://localhost:4402/
```

### Deno / Deno Deploy

```bash
BLINK_USERNAME=you L402_ROOT_KEY=… deno run --allow-net --allow-env --allow-read server/deno.js
```

### Anything else with `fetch`

`paywall.js` is a plain `(Request) => Promise<Response>` handler with no
runtime-specific code; `node.mjs`, `worker.js` and `deno.js` are 40-line
adapters. Vercel, Netlify, Bun, Fastly: wire `createPaywall(...).handle` to
the platform's fetch handler.

## Your content — `content.json`

```json
{
  "ebook": {
    "title": "The Full Article",
    "price": 2.50, "currency": "USD",
    "html": "<article>…revealed in place of the paywall card…</article>"
  },
  "download": {
    "title": "Download link",
    "price": 1000, "currency": "sats",
    "redirect": "https://example.com/files/secret.pdf?sig=…"
  }
}
```

| Field | |
|---|---|
| `title` | shown on the invoice (`Unlock: <title>`) and the demo page |
| `price` + `currency` | `sats` (default) or any Blink display currency (`USD`, `EUR`, `NGN`, …). Fiat prices are quoted at Blink's realtime rate when the invoice is minted. |
| `html` | revealed in place of the paywall card after payment |
| `redirect` | sends the paying visitor to a URL instead (signed download link, Calendly, …) |
| `response` | any other JSON — handed to the widget's `onUnlock` / `blink:unlocked` |

Each key is an item id (letters, numbers, `-`, `_`); its URL is
`/content/<id>`. A broken file fails at boot, not at the first paying visitor.

## Embed

```html
<script defer src="https://blinkbitcoin.github.io/blink-paywall/v1/blink-paywall.js"></script>
<div data-blink-paywall data-l402="https://your-server/content/ebook"
     data-title="Unlock the full article"></div>
```

The [generator](https://blinkbitcoin.github.io/blink-paywall/) builds this
for you and has a **Check** button that verifies the URL answers with a valid
L402 challenge.

## Settings

| Env | Default | |
|---|---|---|
| `BLINK_USERNAME` | — | required; payments go to this Blink account |
| `L402_ROOT_KEY` | random per boot (Node/Deno) | 64 hex chars. **Set it in production.** Workers: `npx wrangler secret put L402_ROOT_KEY` |
| `TOKEN_TTL_DAYS` | `30` | how long a paid unlock stays valid on the visitor's device |
| `INVOICES_PER_MINUTE` | `30` | unpaid invoices one visitor IP may request per minute; `0` disables |
| `PORT` | `4402` | Node / Deno |
| `CONTENT_FILE` | `./content.json` | Node / Deno: another content file |

## Endpoints

| | |
|---|---|
| `GET /content/<id>` | the L402-protected item — this is the `data-l402` URL |
| `GET /` | demo page: every item with the widget mounted, plus its snippet |
| `GET /.well-known/blink-paywall.json` | machine-readable item list (`{ username, items: [{ id, title, price, currency, url }] }`) |

All responses are `Cache-Control: no-store` and CORS-open (`*`): the embed is
cross-origin by nature, and that is safe because tokens travel in an explicit
`Authorization` header, never in cookies.

## How it works (L402)

```
GET /content/ebook
  ← 402  WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
      macaroon = HMAC-signed(root key) over { payment_hash, resource, expiry }
      invoice  = minted into YOUR wallet via the public
                 lnInvoiceCreateOnBehalfOfRecipient mutation (username only)

(visitor pays; the widget obtains the preimage from Blink's public
 payment-status API or from a WebLN wallet)

GET /content/ebook   Authorization: L402 <macaroon>:<preimage>
  ← 200  { "html": ... }
```

Verification is **stateless** and needs no API call:

1. HMAC valid → *we* minted this macaroon, for this resource, and it binds a
   payment hash of an invoice that pays *us*.
2. `sha256(preimage) == payment_hash` → that invoice **was settled** (the
   preimage only leaves the recipient's node on settlement).
3. Caveats: not expired, resource matches.

An attacker cannot self-mint (no root key), cannot pay a cheaper/own invoice
(the hash wouldn't match any macaroon we signed), and cannot guess a preimage.

`macaroon.js` is ported from
[blink-skills](https://github.com/blinkbitcoin/blink-skills)' `_l402_macaroon.js`
and is **wire-compatible**: tokens minted here validate with
`blink l402-verify` and vice versa (see `tests/macaroon.spec.js`). It runs on
Web Crypto, which is why the same file works on every runtime above.

### Self-custodial (Blink Spark) owners

The on-behalf-of mutations need a custodial wallet. Without one, the server
falls back to LNURL-pay on `username@blink.sv`, reads the payment hash out of
the returned invoice (`bolt11.js`) and adds `verify="<LUD-21 url>"` to the
402 challenge so the widget knows where to watch for settlement. Prices are
converted to sats, since Spark wallets are BTC-only.

## Limits / production notes

- **Bearer token**: a paying visitor can share their token, like sharing a
  login. There is no per-visitor identity. If that matters, track used
  payment hashes and bind tokens to sessions — deliberately out of scope here.
- One invoice is minted per unauthorized request; unpaid ones simply expire
  (15 min, 5 for USD-wallet owners). `INVOICES_PER_MINUTE` caps what one IP
  can mint; on Workers the counter is per isolate, so add a Cloudflare rate
  limiting rule if you are a target.
- The demo page at `/` is public by design (it reveals nothing that the 402
  challenges don't). Put the server behind your own path if you'd rather not
  advertise the list of items.
