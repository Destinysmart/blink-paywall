# Blink Paywall, explained

A guided tour of how a Lightning paywall works, using this project as the
worked example. It starts with no code at all and ends with you reading the
token bytes. Stop wherever you have what you came for.

- Parts 1 and 2 need a browser and a Blink account.
- Parts 3 to 5 need a terminal, `node` 20 or newer and `curl`.
- Part 6 is a reading order for the source.

This is an open-source learning project. It continues the prototype Kemal
Yaşar built at Blink in September 2026, it is not an official Blink product,
and nothing in it needs a Blink API key or any account signup for visitors.

## 0. The one fact everything rests on

A paywall needs three things: a price, a way to get paid, and a way to *know*
the payment happened. Lightning gives all three without accounts.

Every Lightning invoice carries a **payment hash**. Behind it is a secret
32-byte number, the **preimage**, that the payer's wallet only receives when
the payment settles. `sha256(preimage) == payment hash`, and there is no other
way to produce it. So "show me the preimage" means "prove you paid this
invoice". The widget, the server and the token format below are all just ways
of moving that proof around.

## 1. Try it in five minutes, no code

1. Open the generator: **https://destinysmart.github.io/blink-paywall/**
2. Type your Blink username and press **Create paywall**. A preview of the
   card appears, already wired to your account.
3. Press **Unlock** on the preview. A QR code appears. That is a real invoice
   that pays you.
4. Pay it from a *second* Blink account or any other Lightning wallet. Blink
   refuses to pay yourself, so your own app will not work for this step.
5. The card turns green and reveals the paid part.

What you just watched: the page asked Blink's public API for an invoice in
your name, showed it, polled until Blink reported it paid, and then ran the
unlock. No server of yours was involved. That is **soft mode**. It is the
honest, "no backend" version, and Part 3 explains exactly why it is soft.

Below the preview the generator shows the snippet to paste into any site. Part
2 explains what is in it.

## 2. What the snippet is

```html
<script defer src="https://destinysmart.github.io/blink-paywall/v1/blink-paywall.js"></script>

<div data-blink-paywall
     data-username="satoshi"
     data-amount="210" data-currency="sats"
     data-id="my-article"
     data-title="Read the rest">
  <template>
    <p>The paid part of the article.</p>
  </template>
</div>
```

- The script tag loads the widget once per page. It scans the page for every
  element with `data-blink-paywall` and mounts a card on each.
- The `data-*` attributes are the whole configuration. `data-username` says
  who gets paid, `data-amount` and `data-currency` set the price (sats or any
  currency Blink can display, converted at Blink's live rate), `data-id` is
  the name the unlock is remembered under, and `data-title` is what the
  visitor sees. The full list is in the [README](README.md#all-attributes).
- The `<template>` holds the locked content. A template is inert HTML: the
  browser parses it but does not render it, does not load its images, and
  does not start its iframes. After payment the widget moves its content into
  the page in place of the card.

A payment can also do things other than reveal: `data-redirect` sends the
visitor to a URL, `data-unlock-class` adds a class to `<html>` so your own CSS
can show hidden parts, and `data-webhook` posts the receipt to a URL. All of
them fire a `blink:unlocked` DOM event you can listen for.

## 3. Soft mode under the hood

Open the browser's developer tools on the generator preview (Network tab,
then Application, Local storage) and press **Unlock** again on a fresh
article. This is what happens, in order. Every call goes to Blink's public
GraphQL endpoint, `https://api.blink.sv/graphql`, with no key.

1. **Who gets paid?** `accountDefaultWallet(username)` returns the wallet id
   and whether it holds BTC or USD.
2. **Mint the invoice.** `lnInvoiceCreateOnBehalfOfRecipient` for a BTC
   wallet, `lnUsdInvoiceCreateOnBehalfOfRecipient` for a USD wallet. The memo
   is `Unlock: <title>`. A fiat price is converted to sats first with
   `realtimePrice`. BTC invoices live 15 minutes, USD ones 5, because a USD
   invoice pegs a fiat amount. The mutation is "on behalf of": anyone may
   create an invoice that pays a Blink user, which is exactly what a public
   paywall needs. The reply includes the payment request and the payment hash.
3. **Show it.** The card renders the QR, a `lightning:` link, a copy button,
   and offers WebLN if the browser has a wallet extension. The invoice is
   written to local storage under `blink-paywall:pending:<username>:<id>` so
   a visitor who pays and then reloads is not charged twice.
4. **Wait for settlement.** The widget polls
   `lnInvoicePaymentStatusByPaymentRequest` every 2 seconds (5 after an error)
   and stops at expiry plus a short grace period. When the status is `PAID`
   the reply carries `paymentPreimage`. That preimage is the proof from Part 0.
5. **Unlock.** A receipt (`id`, `paidAt`, amount, payment hash, preimage) is
   written under `blink-paywall:receipt:<username>:<id>`, the card flashes
   paid, the template content is revealed, the other actions run, and
   `blink:unlocked` is dispatched. On the next visit the receipt is found and
   the card opens straight away, for as long as `data-remember` says.

**Self-custodial owners.** A Blink Spark account has no custodial wallet, so
step 1 fails. The widget then falls back to LNURL-pay at
`https://blink.sv/.well-known/lnurlp/<username>` (LUD-16), and the callback
returns a LUD-21 `verify` URL that it polls instead of the GraphQL status
query. Same proof, different door.

**Why this is "soft".** Everything above ran in the visitor's browser, and
the locked content was in the page source the whole time. Anyone who opens the
developer tools can read the template without paying. The payment itself is
real and goes straight to the owner's wallet; only the *unlocking* is
client-side. This is the same model as most newspaper paywalls, fine for tips,
supporter perks and honest audiences, and not fine for anything a determined
visitor must not reach. For that there is hard mode.

## 4. Hard mode: the server and L402

In hard mode the paid content never reaches the browser before payment. It
lives on a small server that answers every request with "402 Payment
Required" plus an invoice, and releases the content only to a request that
carries the preimage. The protocol is **L402**, and this part walks through
it with `curl`.

### Run the server

```bash
git clone https://github.com/Destinysmart/blink-paywall.git
cd blink-paywall
BLINK_USERNAME=your_blink_username node server/node.mjs
```

The server has no dependencies, so there is nothing to install. At boot it
reads the sample items (two in `server/content.json`, one in
`server/items/example-story.md`), prints a root key you could keep, and
prints `http://localhost:4402/`. Open that address for a demo page that lists the
items with the widget already mounted.

Without `L402_ROOT_KEY` the server generates a random key each start, which
is fine for this tour. In production you set it once and keep it, because a
new key invalidates every unlock already sold.

### Ask for the content

```bash
curl -i http://localhost:4402/content/example-story
```

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: L402 macaroon="AUyh…", invoice="lnbc1u1p…"
Cache-Control: no-store

{"error":"payment required"}
```

Two things came back in that header:

- the **invoice** for the item's price, minted into the owner's wallet with
  the same on-behalf-of mutation the widget uses in soft mode;
- a **macaroon**: a token the server signed that says "whoever shows me the
  preimage of *this* payment hash may read *this* item until *this* date".

Nothing was stored. The server can forget the request entirely and still
recognise the token later, because the token carries its own proof.

### Pay, and fetch the preimage

Pay the invoice from a wallet that is not the owner's own Blink account. Then
ask Blink's public API for the preimage, exactly as the widget would:

```bash
curl -s https://api.blink.sv/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"query($input: LnInvoicePaymentStatusByPaymentRequestInput!){ lnInvoicePaymentStatusByPaymentRequest(input:$input){ status paymentPreimage } }","variables":{"input":{"paymentRequest":"lnbc1u1p…"}}}'
```

```json
{"data":{"lnInvoicePaymentStatusByPaymentRequest":{"status":"PAID","paymentPreimage":"3f9c…"}}}
```

Some wallets also show the preimage in the payment's details screen. Either
way, you now hold the only thing in the world that proves this invoice was
paid.

### Present the proof

```bash
curl -i http://localhost:4402/content/example-story \
  -H 'Authorization: L402 AUyh…:3f9c…'
```

```
HTTP/1.1 200 OK

{"html":"<h2>The part worth paying for</h2><p>…"}
```

The server checked three things, all offline:

1. The macaroon's signature is a valid HMAC under its root key, so the server
   minted it, for this item, bound to this payment hash.
2. `sha256(preimage)` equals the payment hash inside the macaroon, so that
   invoice was paid.
3. The caveats hold: the token has not expired and names this item.

An attacker cannot mint a token without the root key, cannot substitute a
cheaper invoice they paid because its hash matches no macaroon the server
signed, and cannot guess a 256-bit preimage. The server needs no database and
no Blink API key. A copy of it on Cloudflare's free tier serves this for
nothing.

### What the token looks like

The macaroon is base64url over these bytes:

```
[0]         version, 0x01
[1..32]     payment hash
[33..N]     caveats, type-length-value: 0x01 expiry (unix seconds), 0x02 item id
[N+1..N+32] HMAC-SHA256(root key, everything above)
```

It is deliberately not the full macaroon specification, just the part L402
needs. The format is byte-identical to the one in Blink's
[blink-skills](https://github.com/blinkbitcoin/blink-skills), and
`tests/macaroon.spec.js` pins a frozen test vector to keep it that way.

### How the widget does the same

```html
<script defer src="https://destinysmart.github.io/blink-paywall/v1/blink-paywall.js"></script>
<div data-blink-paywall data-l402="http://localhost:4402/content/example-story"
     data-title="Read the rest"></div>
```

With `data-l402` the widget becomes an L402 client. It fetches the URL,
parses the 402, shows the invoice with the same card as soft mode, obtains the
preimage from the status poll (or from WebLN, whichever wins), refetches with
the `Authorization` header, and lets the 200 body decide what happens:
`{ "html" }` is revealed in place of the card, `{ "redirect" }` navigates, any
other JSON goes to your `blink:unlocked` listener. The `macaroon:preimage`
pair is kept under `blink-paywall:token:<url>` and replayed on the next
visit, so a returning reader is let in without a round trip to Blink.

**Self-custodial owners, again.** When the owner has no custodial wallet the
server mints the invoice through LNURL-pay instead, decodes the payment hash
out of the bolt11 invoice itself (`server/bolt11.js`), and adds a
`verify="…"` parameter to the 402 challenge pointing at the LUD-21 URL. The
widget polls that. The parameter is an extension; a widget that ignores it
still sees a standard L402 challenge.

## 5. Put it on the internet

The server is one file that takes a `Request` and returns a `Response`, with
thin adapters for Node, Cloudflare Workers and Deno.

- **Cloudflare Workers, free.** Press the Deploy button in
  [`server/README.md`](server/README.md). It asks for your Blink username, a
  root key (`openssl rand -hex 32`, keep it) and an admin password. Your items
  then live at `https://<worker>.workers.dev/content/<id>`.
- **Any VPS.** The `node server/node.mjs` line from Part 4 with
  `L402_ROOT_KEY` set.

Items come from three places, and a later one wins over an earlier one:
`server/content.json`, one Markdown or HTML file per item in `server/items/`
with the title and price in a short header, or the generator's **On my
server** option, which connects with the admin password and saves items
straight into the server's store. The [server README](server/README.md)
covers all three and every setting.

## 6. Reading the code

Read it in this order. Each file is short and the comment at the top says
what it does and does not do.

| File | What to learn from it |
|---|---|
| [`src/index.js`](src/index.js) | how `data-*` attributes become a config, and the public `BlinkPaywall` API |
| [`src/paywall.js`](src/paywall.js) | the state machine: locked, invoice, paid, unlocked, with expired and error exits. It knows nothing about Blink or HTTP |
| [`src/sources/blink.js`](src/sources/blink.js) | soft mode as a *payment source*: `challenge` mints, `settle` waits, `checkOnce` handles reloads |
| [`src/sources/l402.js`](src/sources/l402.js) | hard mode as the same interface, plus `finalize` (refetch with the token) and `restore` (replay it) |
| [`src/blink.js`](src/blink.js) | the five GraphQL calls and the bounded poller |
| [`src/l402.js`](src/l402.js) | parsing the `WWW-Authenticate` header and the invoice amount, pure functions |
| [`src/actions.js`](src/actions.js) | what an unlock does, as a registry you can extend from your own script |
| [`server/paywall.js`](server/paywall.js) | the server: 402 on one path, 200 on another, nothing else |
| [`server/macaroon.js`](server/macaroon.js) | mint and verify, on Web Crypto so it runs everywhere |
| [`server/bolt11.js`](server/bolt11.js) | a full invoice decoder, needed only for the LNURL path |

The tests are the second-best explanation. `npm test` runs them all in a few
seconds without touching the Blink API:

- `tests/paywall.spec.js` drives the whole widget flow with a fake payment
  source against the real card.
- `tests/server.spec.js` runs the server with a fake Blink that records which
  mutation was called with what amount.
- `tests/macaroon.spec.js` holds the frozen byte-for-byte vector.
- `tests/bolt11.spec.js` decodes a real invoice Blink minted.

## 7. Limits, stated plainly

- **Soft mode is soft.** See Part 3. Never describe it as secure.
- **The L402 token is a bearer token.** A paying reader can hand it to a
  friend, like sharing a login. Binding tokens to sessions is deliberately
  out of scope.
- **One-time unlocks only.** No subscriptions, no per-reader accounts.
- **The webhook is sent by the browser** and can be forged. Treat it as a
  notification, never as proof of payment.
- **Downloads are not streamed.** A `redirect` item sends the reader to a
  URL; protecting the file behind that URL is up to you.
- **Polling, not subscriptions.** The widget asks Blink every 2 seconds.
- **The server's rate limiter is in memory**, per process or per Worker
  isolate.

## Glossary

- **Invoice (bolt11).** A string starting `lnbc…` that encodes an amount, a
  payment hash, an expiry and the recipient. Shown as the QR.
- **Payment hash and preimage.** The lock and the key. The hash is public, in
  the invoice; the preimage is revealed to the payer only on settlement.
- **L402.** The convention of answering HTTP 402 with a `WWW-Authenticate:
  L402` challenge and accepting `Authorization: L402 macaroon:preimage`.
- **Macaroon.** A signed token with caveats (conditions). Here: payment hash,
  expiry, item id, signature.
- **LNURL-pay (LUD-16) and verify (LUD-21).** A way to request an invoice
  from a web address, and a URL to ask whether it was paid. Used for
  self-custodial Blink accounts.
- **WebLN.** A browser API that lets a wallet extension pay an invoice and
  return the preimage without leaving the page.
- **Custodial and Spark.** A custodial Blink account holds its funds with
  Blink and supports on-behalf-of invoices. A Spark account is
  self-custodial and is reached through LNURL instead.
