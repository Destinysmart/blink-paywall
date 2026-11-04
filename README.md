# Blink Paywall

A Lightning paywall for any website: one pasted snippet gates **an
owner-defined action** behind a payment to your [Blink](https://get.blink.sv)
account. No API key, no account signup for visitors.

Generator (for non-technical users):
**https://destinysmart.github.io/blink-paywall/**

Two ways to run it:

- **Hard paywall (recommended)** — the content stays on *your* server and is
  released only after the payment is cryptographically verified ([L402](https://docs.lightning.engineering/the-lightning-network/l402)).
  The [`server/`](server/) folder is that server: zero dependencies, deploys
  to Cloudflare Workers (free) with one click, or runs on Node / Deno. Once it
  is up, the generator connects to it and items are written, priced and saved
  from the page — no files, no JSON.
- **Soft paywall** — no backend at all; everything happens in the visitor's
  browser. Honest-audience grade: see [Security model](#security-model-read-this).

```html
<script defer src="https://destinysmart.github.io/blink-paywall/v1/blink-paywall.js"></script>

<!-- hard: your server holds the content -->
<div data-blink-paywall data-l402="https://paywall.you.workers.dev/content/ebook"
     data-title="Unlock the full article"></div>

<!-- soft: the locked content is right here, in an inert <template> -->
<div data-blink-paywall
     data-username="satoshi"
     data-amount="2.50" data-currency="USD"
     data-id="ebook-1"
     data-title="Unlock the full article"
     data-remember="30d">
  <template>
    <!-- locked content: any HTML. Inert until paid — iframes don't even load. -->
  </template>
</div>
```

The visitor sees a card with an "Unlock" button → Lightning invoice QR
(WebLN / `lightning:` deeplink / copy) → on payment the action runs. The
unlock is remembered in `localStorage`.

## What can a payment unlock?

Everything is driven by which attributes are present; all that apply run:

| Attribute | Action | Typical use |
|---|---|---|
| `data-l402="url"` | **hard paywall** — the server's 200 response drives the action (`{ "html" }` is revealed, `{ "redirect" }` navigates, anything else goes to `onUnlock`) | content that must stay server-side |
| `<template>` child | **reveal** — the template content replaces the card | article, secret code, download link, YouTube/PDF iframe, image, audio |
| `data-redirect="url"` | navigate after payment (runs last) | thank-you page, signed download URL, Calendly |
| `data-unlock-class="x"` | add class `x` to `<html>` | unlock any part of the page with pure CSS |
| `data-webhook="url"` | POST the receipt (JSON) to a URL | Zapier / Make / n8n → email, Google Sheets, Discord |
| always | `blink:unlocked` DOM event (bubbles) + `onUnlock(receipt, response)` via `BlinkPaywall.mount(el, { onUnlock })` | anything JavaScript can do |

Developers can add actions without touching this project (a plugin gets its
own `data-confetti` trigger, for example):

```js
BlinkPaywall.actions.confetti = ({ el, config, receipt, response }) => {
  if (config.confetti === undefined) return; // runs only when data-confetti is set
  /* ... */
};
```

## All attributes

| Attribute | Default | |
|---|---|---|
| `data-l402` | — | URL of an L402-protected resource (hard mode) |
| `data-username` | — | your Blink username (soft mode; required unless `data-l402`) |
| `data-amount` + `data-currency` | — / `sats` | price (soft mode; in hard mode the server sets it); currency `sats`, `USD`, `EUR`, ... (any Blink display currency) |
| `data-id` | page path | unlocks are remembered per `username`+`id` |
| `data-title`, `data-description` | — | card text |
| `data-remember` | `forever` | `24h`, `7d`, `30d`, ... (`Nm/Nh/Nd`) — how long the unlock lasts on the device |
| `data-theme` | `auto` | `auto` follows the visitor's own light/dark preference; `light` or `dark` pins it |
| `data-redirect`, `data-webhook`, `data-unlock-class` | — | actions, see above |

JS API (for SPAs / custom flows): `BlinkPaywall.scan()`,
`BlinkPaywall.mount(elementOrSelector, overrides)`, `BlinkPaywall.actions`,
`BlinkPaywall.version`. Multiple paywalls per page are fine.

## Security model — read this

**Hard mode (`data-l402`) is a real paywall.** Your server keeps the content
and only releases it after cryptographic payment verification, speaking the
standard L402 protocol ("HTTP 402 Payment Required"):

```
GET url                                   → 402, WWW-Authenticate: L402 macaroon="…", invoice="…"
(widget shows the QR; visitor pays; preimage obtained from Blink's public
 payment-status API, the LUD-21 verify URL, or the WebLN wallet)
GET url  Authorization: L402 mac:preimage → 200 → response unlocks the card
```

The 200 response controls the action: `{ "html": "…" }` is revealed in place
of the card, `{ "redirect": "…" }` navigates, any other JSON is handed to
`onUnlock`/`blink:unlocked`. The token is stored and replayed on return
visits until your server says no.

[`server/`](server/) is a zero-dependency implementation (no Blink API key
needed) with a one-click Cloudflare deploy, a `content.json` for your items,
fiat or sats prices, and self-custodial (Spark) owner support; the threat
model is in its README. Its macaroons are wire-compatible with
[blink-skills](https://github.com/blinkbitcoin/blink-skills)' `blink l402-verify`.

`data-l402` also works against **any** L402 resource on the internet, not
just our server — note that non-Blink invoices settle only through a WebLN
wallet (there is no public status API to poll).

**Soft mode (`data-username`) is a soft paywall.** The whole flow runs in the
visitor's browser; the locked content is in the page source and a determined
visitor can open DevTools and take it. That is the same model as most
newspaper paywalls, and it is the honest price of "no backend". Fine for
tips, articles, supporter perks and honest audiences. Payments themselves are
real and go straight to your wallet; nothing about *money* is spoofable —
only the *unlocking* is client-side.

The `data-webhook` POST comes from the visitor's browser and can be forged —
treat it as a notification, never as proof of payment.

## Self-custodial (Blink Spark) recipients

Both modes work. Soft mode falls back to LNURL-pay on `username@blink.sv`
and detects settlement via LUD-21 `verify`; the hard-mode server does the
same on the server side and tells the widget where to look (a `verify="…"`
parameter on the 402 challenge).

## Development

```bash
npm install
npm test            # vitest — widget (jsdom) + server (node) unit and flow tests
npm run lint
npm run build       # esbuild → v1/blink-paywall.js (single file, no runtime deps)
npm run dev         # watch + serve
npm run server      # BLINK_USERNAME=you npm run server → http://localhost:4402/ (hard mode)
```

Manual end-to-end: `examples/soft.html` (soft) and the server's demo page
(hard). A real payment needs a *second* Blink account — Blink blocks paying
yourself.

Architecture: `src/paywall.js` orchestrates a per-element state machine
(locked → invoice → paid → unlocked) and depends only on interfaces:
payment *sources* (`src/sources/blink.js` soft, `src/sources/l402.js` hard —
same shape: `challenge / settle / checkOnce / finalize? / restore?`), the
*view* (`src/ui.js`, shadow DOM), *storage* and the open *actions* registry.
Adding a payment source or an action touches nothing else. `server/` is the
same idea on the other side of the wire: `paywall.js` is one runtime-neutral
`(Request) => Response` handler; the entry points are thin adapters.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
