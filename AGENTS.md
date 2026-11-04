# AGENTS.md — architecture and guardrails

One-paragraph mental model: **a paywall instance is a state machine**
(`locked → invoice → paid → unlocked`, side exits `expired`/`error`) that
buys a `{ preimage }` from a *payment source*, turns it into a *receipt*,
persists it, and hands it to the *actions* registry. Everything else is
plumbing around that sentence. The **server** is the hard-mode payment
source's counterpart: it mints the invoice, binds it into a macaroon, and
releases the content only for `macaroon:preimage`.

## Map

```
src/index.js          public API (mount/scan/actions/version) + auto-scan; el.dataset IS the config parser
src/paywall.js        the state machine; source + view are INJECTED (test with fakes)
src/sources/blink.js  soft mode: public on-behalf invoice; Spark fallback via LNURL
src/sources/l402.js   hard mode: 402 client; bearer token per URL in localStorage; settles via
                      Blink status poll, or LUD-21 verify when the challenge carries verify="…"
src/blink.js          Blink public GraphQL + generic bounded poll() (2s, 5s backoff, expiry+5s grace)
src/lnurl.js          LUD-16 pay + LUD-21 verify (ported from donation-button.blink.sv)
src/l402.js           pure: WWW-Authenticate parse (+ verify extension), bolt11 HRP amount decode
src/actions.js        registry: webhook, unlockClass, reveal, redirect (redirect always last)
src/storage.js        receipts / pending invoices / L402 tokens; ALL guarded try/catch
src/ui.js             shadow-DOM card; reports intent via handlers (onUnlock/onRetry/onPreimage)
src/qr.js             vendored qrcode-generator 1.4.4 (MIT) — do not edit, eslint-ignored
index.html+generator.js  generator page, served raw (no build); hard mode first, soft below

server/paywall.js     THE hard-paywall server: createPaywall(options).handle(Request) → Response.
                      Web standard only (fetch/Request/Response/Web Crypto): no node:*, no DOM.
server/macaroon.js    L402 macaroon mint/verify on Web Crypto (async). WIRE-COMPATIBLE with
                      blink-skills _l402_macaroon.js (byte-identical vector in tests/macaroon.spec.js)
server/bolt11.js      full bolt11 decode (bech32 checksum, tagged fields) — the LNURL path needs the
                      payment hash out of the invoice itself
server/node.mjs       node:http adapter        BLINK_USERNAME=you node server/node.mjs
server/worker.js      Cloudflare Workers entry  (content.json imported as a module)
server/deno.js        Deno / Deno Deploy entry
server/content.json   the owner's items: { id: { title, price, currency, html | redirect | response } }
server/wrangler.jsonc, package.json, .dev.vars.example   what "Deploy to Cloudflare" reads
```

Build: esbuild → `v1/blink-paywall.js` (IIFE, global `BlinkPaywall`, `.css`
imported as text). `/v1/` is gitignored; CI builds it on deploy, so the
published URL is `<pages-origin>/v1/blink-paywall.js`. `server/` has no build.

Hosting: GitHub Pages from `main` via Actions, currently
`https://blinkbitcoin.github.io/blink-paywall/`. `paywall.blink.sv` is the
intended domain: adding it = DNS record + a `CNAME` file + swapping the URL
in `generator.js` (`SCRIPT_URL`), `README.md`, `src/index.js` (doc comment),
`server/paywall.js` (`WIDGET_URL`), `server/README.md` and `index.html`
(canonical + og:url). The "Deploy to Cloudflare" links in `index.html` and
`server/README.md` point at `blinkbitcoin/blink-paywall/tree/main/server`.

## Payment flow (high level)

1. **Soft, custodial-first**: `accountDefaultWallet(username)` →
   `ln(Usd)InvoiceCreateOnBehalfOfRecipient` (sats / cents, memo
   `Unlock: <title>`, 15/5-min expiry) → poll public
   `lnInvoicePaymentStatusByPaymentRequest`, which returns the **preimage**
   when PAID.
2. **Soft, Spark fallback**: no custodial wallet → LNURL-pay
   `blink.sv/.well-known/lnurlp/<user>` → poll LUD-21 `verify`.
3. **Hard (L402)**: fetch → 402 → parse header → same QR UI → preimage from
   the Blink poll (or the LUD-21 verify URL if the challenge has `verify=`)
   *raced against WebLN* (`ui.js` hands it up) → refetch with
   `Authorization: L402 macaroon:preimage` → 200 body drives the actions.
4. **Server side of 3**: same wallet lookup + same mutation table as the widget
   (`MUTATIONS` in both); no wallet → LNURL-pay + `bolt11.decodeInvoice` for
   the hash + `verify="…"` on the challenge. Token check is pure crypto:
   HMAC + `sha256(preimage) == hash` + caveats (expiry, resource).

Everything is called unauthenticated. The server needs no API key either
(public on-behalf mutation + stateless HMAC macaroon).

## Invariants (don't break these)

- **Zero runtime dependencies.** Dev-deps only. New npm packages need a very
  good reason. `server/` has none at all, dev or otherwise.
- The public embed contract is frozen: one script tag + `[data-blink-paywall]`
  attributes + `BlinkPaywall.{mount,scan,actions,version}` + the
  `blink:unlocked` event. Additive changes only; the deployed URL is
  versioned (`/v1/`) — breaking changes mean `/v2/`.
- The 402 challenge is standard L402 (`macaroon`, `invoice`); `verify` is an
  additive extension the widget tolerates being absent. Never require it.
- `paywall.js` must not import concrete sources; `sources/*` must not touch
  the DOM; `ui.js` must not do payments; `storage.js` never throws.
- `server/` is **self-contained**: no imports from `src/` (Deploy to
  Cloudflare treats that folder as a repository root), and `paywall.js` stays
  runtime-neutral — anything `node:`/`Deno.`/Workers-specific lives in the
  adapters.
- Pollers are bounded (invoice expiry + grace) and cancellable
  (AbortController). Never ship an unbounded poll loop.
- Locked content stays inert: it lives in `<template>` (or server-side in
  hard mode). Never render/fetch it pre-payment.
- The soft/hard security distinction in README (`## Security model`) is
  honest marketing law: never describe soft mode as secure. The generator
  leads with hard mode for the same reason.
- `server/macaroon.js` stays wire-compatible with blink-skills
  (`tests/macaroon.spec.js` has the frozen byte-identical vector).
- Server responses are `Cache-Control: no-store`: a shared cache must never
  serve paid content or replay a 402 with someone else's invoice.
- The generator's URL state always writes `type`: links saved before hard
  mode became the default have none, and that absence is what marks them as
  soft "content" setups (`applyHash`).

## Testing

`npm test` — vitest. Widget specs run in jsdom; `tests/server.spec.js`,
`tests/macaroon.spec.js` and `tests/bolt11.spec.js` carry
`// @vitest-environment node` and inject `fetch` through `createPaywall`'s
options (a fake Blink that logs the mutation and amount used).
`tests/paywall.spec.js` runs the full widget flow with a fake source against
the REAL view (shadow DOM), fake timers. The Blink API is never hit in tests.
`tests/bolt11.spec.js` uses a real Blink-minted invoice whose hash the API
returned alongside it. Manual e2e needs a second Blink account (CANT_PAY_SELF).

Known deliberate cuts: polling only (no GraphQL WS subscription), English
only, no replay protection on L402 tokens (bearer semantics, as blink-skills),
browser-POST webhook is spoofable (Blink's invoice `webhookUrl` input could
replace it once its callback payload is documented), the server's rate
limiter is in-memory (per Worker isolate).
