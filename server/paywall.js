/**
 * Blink Paywall server — the HARD paywall backend, runtime-agnostic.
 *
 * `createPaywall(options).handle(request)` speaks Web standard Request /
 * Response, so this one file runs on Node 20+ (node.mjs), Cloudflare Workers
 * (worker.js), Deno (deno.js) and anything else that has `fetch`.
 *
 * Zero dependencies, no database, no Blink API key:
 *   - invoices are minted into the OWNER's Blink wallet with the public
 *     on-behalf-of mutations (custodial) or LNURL-pay (self-custodial Spark)
 *   - access tokens are stateless macaroons (macaroon.js); verification is
 *     pure crypto: HMAC (we minted it) + preimage (it was paid) + caveats
 *
 * Routes:
 *   GET /content/:id                      the L402-protected item (goes in data-l402)
 *   GET /                                 demo page embedding the widget for every item
 *   GET /.well-known/blink-paywall.json   machine-readable item list (the generator reads it)
 */

import { decodeInvoice } from './bolt11.js';
import { createMacaroon, hexToBytes, verifyToken } from './macaroon.js';

export const VERSION = '0.2.0';
export const API_URL = 'https://api.blink.sv/graphql';
export const LNURL_DOMAIN = 'blink.sv';
export const WIDGET_URL = 'https://blinkbitcoin.github.io/blink-paywall/v1/blink-paywall.js';

/** Invoice expiry minutes per wallet currency (USD invoices peg a fiat amount, so short). */
const EXPIRY_MINUTES = { BTC: 15, USD: 5 };
const WALLET_CACHE_MS = 10 * 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAP_CAP = 10_000;
const ID_PATTERN = /^[\w-]+$/;

/**
 * The public "on behalf of recipient" mutation for each
 * (wallet currency, invoice denomination) pair — same table as the widget.
 */
const MUTATIONS = {
    'BTC:sats': 'lnInvoiceCreateOnBehalfOfRecipient',
    'USD:cents': 'lnUsdInvoiceCreateOnBehalfOfRecipient',
    'USD:sats': 'lnUsdInvoiceBtcDenominatedCreateOnBehalfOfRecipient',
};

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'WWW-Authenticate',
    'Access-Control-Max-Age': '86400',
};

/**
 * Normalize content.json into `{ id: { id, title, price, currency, body } }`.
 * Accepts the v0.1 server's `{ priceSats, body }` shape too. Throws on
 * anything ambiguous: a misconfigured paywall must fail at boot, not at the
 * first paying visitor.
 */
export function normalizeContent(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('content must be an object keyed by item id');
    }
    const items = {};
    for (const [id, item] of Object.entries(raw)) {
        if (!ID_PATTERN.test(id)) {
            throw new Error(`content: id "${id}" may only use letters, numbers, "_" and "-"`);
        }
        if (!item || typeof item !== 'object') {
            throw new Error(`content: item "${id}" must be an object`);
        }
        let price = item.price;
        let currency = item.currency || 'sats';
        if (price === undefined && item.priceSats !== undefined) {
            price = item.priceSats;
            currency = 'sats';
        }
        price = Number(price);
        if (!(price > 0)) throw new Error(`content: item "${id}" needs a positive price`);
        currency = String(currency).toLowerCase() === 'sats' ? 'sats' : String(currency).toUpperCase();
        if (currency === 'sats') price = Math.round(price);

        let body;
        if (typeof item.html === 'string') body = { html: item.html };
        else if (typeof item.redirect === 'string') body = { redirect: item.redirect };
        else if (item.response && typeof item.response === 'object') body = item.response;
        else if (item.body && typeof item.body === 'object') body = item.body;
        else throw new Error(`content: item "${id}" needs html, redirect or response`);

        items[id] = { id, title: String(item.title || id), price, currency, body };
    }
    return items;
}

/** "2100 sats", "$2.50", "€2.50" — Intl gets each currency's decimals right. */
export function formatPrice(amount, currency) {
    if (currency === 'sats') return `${amount} sats`;
    try {
        return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount);
    } catch {
        return `${amount} ${currency}`;
    }
}

function parseRootKey(rootKey) {
    if (rootKey instanceof Uint8Array) {
        if (rootKey.length === 32) return rootKey;
    } else if (typeof rootKey === 'string' && /^[0-9a-fA-F]{64}$/.test(rootKey.trim())) {
        return hexToBytes(rootKey.trim());
    }
    throw new Error(
        'L402_ROOT_KEY must be 64 hex characters (32 bytes) — generate one with: openssl rand -hex 32'
    );
}

function clientIp(request, context) {
    if (context && context.ip) return String(context.ip);
    const headers = request.headers;
    return (
        headers.get('cf-connecting-ip') ||
        (headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
        headers.get('x-real-ip') ||
        'unknown'
    );
}

/** The origin visitors see, honouring a TLS-terminating proxy in front of Node. */
function publicOrigin(request) {
    const url = new URL(request.url);
    const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
    const host = request.headers.get('x-forwarded-host') || url.host;
    return `${proto}://${host}`;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

class BlinkApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BlinkApiError';
        this.graphql = true;
    }
}

/**
 * @param {object} options
 * @param {string} options.username        Blink username — payments go to this account
 * @param {string|Uint8Array} options.rootKey  64 hex chars (or 32 bytes); signs every token
 * @param {object} options.content         content.json (see normalizeContent)
 * @param {number} [options.tokenTtlDays]  how long a paid unlock stays valid (30)
 * @param {number} [options.invoicesPerMinute]  per visitor IP; 0 disables the limiter (30)
 * @param {string} [options.contentPath]   URL prefix of the items ('/content/')
 * @param {Function} [options.fetch]       injectable for tests
 * @param {Function} [options.now]         injectable clock (ms), for tests
 */
export function createPaywall(options = {}) {
    const username = String(options.username || '')
        .trim()
        .replace(/^@/, '')
        .toLowerCase();
    if (!username) {
        throw new Error('BLINK_USERNAME is required (payments go to that Blink account).');
    }
    const rootKey = parseRootKey(options.rootKey);
    const items = normalizeContent(options.content);
    const tokenTtlDays = Number(options.tokenTtlDays ?? 30);
    if (!(tokenTtlDays > 0)) throw new Error('TOKEN_TTL_DAYS must be a positive number.');
    const invoicesPerMinute = Number(options.invoicesPerMinute ?? 30);
    const contentPath = options.contentPath || '/content/';
    const fetchFn = options.fetch || globalThis.fetch;
    const now = options.now || (() => Date.now());

    // ── Blink public API (no key) ────────────────────────────────────────────

    async function gql(query, variables) {
        const response = await fetchFn(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables }),
        });
        if (!response.ok) throw new Error(`Blink API returned ${response.status}`);
        const data = await response.json();
        if (data.errors && data.errors.length) {
            throw new BlinkApiError(data.errors[0].message || 'Blink API error');
        }
        return data.data;
    }

    let walletCache = null; // { wallet, expires } — null wallet = self-custodial

    /** @returns {Promise<{id: string, currency: 'BTC'|'USD'}|null>} null = no custodial wallet */
    async function getDefaultWallet() {
        if (walletCache && walletCache.expires > now()) return walletCache.wallet;
        let wallet = null;
        try {
            const data = await gql(
                `query DefaultWallet($username: Username!) {
                    accountDefaultWallet(username: $username) { id currency }
                }`,
                { username }
            );
            const found = data && data.accountDefaultWallet;
            wallet = found && found.id ? { id: found.id, currency: found.currency } : null;
        } catch (error) {
            // A GraphQL error means "no custodial wallet" (unknown or Spark
            // user) -> LNURL decides. A network failure is NOT cached.
            if (!error.graphql) throw error;
        }
        walletCache = { wallet, expires: now() + WALLET_CACHE_MS };
        return wallet;
    }

    async function getRate(currency) {
        const data = await gql(
            `query RealtimePrice($currency: DisplayCurrency!) {
                realtimePrice(currency: $currency) {
                    btcSatPrice { base offset }
                    usdCentPrice { base offset }
                }
            }`,
            { currency: currency.toUpperCase() }
        );
        const price = data.realtimePrice;
        return {
            satPrice: price.btcSatPrice.base / Math.pow(10, price.btcSatPrice.offset),
            usdCentPrice: price.usdCentPrice.base / Math.pow(10, price.usdCentPrice.offset),
        };
    }

    /**
     * Price -> integer invoice amount + unit. Same rules as the widget: a sats
     * price is always invoiced in sats (even into a USD wallet) so the payer
     * is quoted the advertised number; fiat into a USD wallet is cents; fiat
     * into a BTC wallet converts at the realtime rate.
     */
    async function computeInvoiceAmount(amount, currency, walletCurrency) {
        if (walletCurrency !== 'BTC' && walletCurrency !== 'USD') {
            throw new Error(`Unsupported wallet currency: ${walletCurrency}`);
        }
        if (currency === 'sats') return { amount: Math.round(amount), unit: 'sats' };
        if (walletCurrency === 'BTC') {
            const rate = await getRate(currency);
            return { amount: Math.round((amount * 100) / rate.satPrice), unit: 'sats' };
        }
        if (currency === 'USD') return { amount: Math.round(amount * 100), unit: 'cents' };
        const rate = await getRate(currency);
        return { amount: Math.round((amount * 100) / rate.usdCentPrice), unit: 'cents' };
    }

    async function createInvoice({ walletId, walletCurrency, amount, unit, memo }) {
        const name = MUTATIONS[`${walletCurrency}:${unit}`];
        if (!name) throw new Error(`Cannot invoice a ${walletCurrency} wallet in ${unit}`);
        const inputType = name[0].toUpperCase() + name.slice(1) + 'Input';
        const data = await gql(
            `mutation CreateInvoice($input: ${inputType}!) {
                ${name}(input: $input) {
                    invoice { paymentRequest paymentHash }
                    errors { message }
                }
            }`,
            {
                input: {
                    recipientWalletId: walletId,
                    amount: String(amount),
                    memo,
                    expiresIn: String(EXPIRY_MINUTES[walletCurrency]),
                },
            }
        );
        const payload = data[name];
        if (payload.errors && payload.errors.length) {
            throw new Error(payload.errors[0].message || 'Could not create invoice');
        }
        if (!payload.invoice || !payload.invoice.paymentRequest) {
            throw new Error('Could not create invoice');
        }
        return payload.invoice;
    }

    /** LNURL-pay (LUD-16) to username@blink.sv + the LUD-21 verify URL. */
    async function getLnurlInvoice(amountSats, memo) {
        const endpoint = `https://${LNURL_DOMAIN}/.well-known/lnurlp/${encodeURIComponent(username)}`;
        const metaResponse = await fetchFn(endpoint, { headers: { Accept: 'application/json' } });
        if (metaResponse.status === 404) throw new Error(`Blink user "${username}" not found`);
        if (!metaResponse.ok) throw new Error(`LNURL endpoint returned ${metaResponse.status}`);
        const meta = await metaResponse.json();
        if (meta.tag !== 'payRequest' || !meta.callback) {
            throw new Error('Invalid LNURL pay response');
        }
        const amountMsats = Math.round(amountSats) * 1000;
        if (typeof meta.minSendable === 'number' && amountMsats < meta.minSendable) {
            throw new Error(`Price is below the minimum of ${Math.ceil(meta.minSendable / 1000)} sats`);
        }
        if (typeof meta.maxSendable === 'number' && amountMsats > meta.maxSendable) {
            throw new Error(`Price exceeds the maximum of ${Math.floor(meta.maxSendable / 1000)} sats`);
        }
        const url = new URL(meta.callback);
        url.searchParams.set('amount', String(amountMsats));
        const commentAllowed = meta.commentAllowed || 0;
        if (commentAllowed > 0 && memo) url.searchParams.set('comment', memo.slice(0, commentAllowed));

        const callbackResponse = await fetchFn(url.toString(), {
            headers: { Accept: 'application/json' },
        });
        if (!callbackResponse.ok) {
            throw new Error(`LNURL callback returned ${callbackResponse.status}`);
        }
        const callback = await callbackResponse.json();
        if (callback.status === 'ERROR') {
            throw new Error(`LNURL error: ${callback.reason || 'Unknown error'}`);
        }
        if (!callback.pr) throw new Error('LNURL callback did not return a payment request');
        return { paymentRequest: callback.pr, verifyUrl: callback.verify };
    }

    /**
     * Mint the invoice for an item.
     * @returns {Promise<{paymentRequest: string, paymentHash: string, verifyUrl?: string}>}
     */
    async function mintChallenge(item) {
        // Shows in the owner's Blink transaction list; skip the prefix when the
        // title already says "Unlock ...".
        const memo = /^unlock\b/i.test(item.title) ? item.title : `Unlock: ${item.title}`;
        const wallet = await getDefaultWallet();
        if (wallet) {
            const { amount, unit } = await computeInvoiceAmount(
                item.price,
                item.currency,
                wallet.currency
            );
            const invoice = await createInvoice({
                walletId: wallet.id,
                walletCurrency: wallet.currency,
                amount,
                unit,
                memo,
            });
            return { paymentRequest: invoice.paymentRequest, paymentHash: invoice.paymentHash };
        }
        // Self-custodial (Spark): BTC only, so the price becomes sats; the
        // payment hash is read out of the invoice itself.
        const { amount: sats } = await computeInvoiceAmount(item.price, item.currency, 'BTC');
        const invoice = await getLnurlInvoice(sats, memo);
        const { paymentHash } = decodeInvoice(invoice.paymentRequest);
        return { paymentRequest: invoice.paymentRequest, paymentHash, verifyUrl: invoice.verifyUrl };
    }

    // ── abuse guard: one unpaid invoice per unauthorized request adds up ─────

    const minted = new Map(); // ip -> [timestamps]

    function overLimit(ip) {
        if (!(invoicesPerMinute > 0)) return false;
        const current = now();
        const cutoff = current - RATE_WINDOW_MS;
        const stamps = (minted.get(ip) || []).filter((stamp) => stamp > cutoff);
        if (stamps.length >= invoicesPerMinute) {
            minted.set(ip, stamps);
            return true;
        }
        stamps.push(current);
        if (minted.size >= RATE_MAP_CAP && !minted.has(ip)) minted.clear(); // crude memory cap
        minted.set(ip, stamps);
        return false;
    }

    // ── HTTP ─────────────────────────────────────────────────────────────────

    function respond(status, body, headers = {}) {
        return new Response(body, {
            status,
            headers: { ...CORS, 'Cache-Control': 'no-store', ...headers },
        });
    }

    function json(status, value, headers = {}) {
        return respond(status, JSON.stringify(value), {
            'Content-Type': 'application/json; charset=utf-8',
            ...headers,
        });
    }

    async function handleContent(request, id, context) {
        const item = items[id];
        if (!item) return json(404, { error: 'unknown content id' });

        // 1. Valid token -> content. Stateless: HMAC + preimage + caveats.
        const check = await verifyToken({
            authorization: request.headers.get('authorization'),
            rootKey,
            resource: id,
            nowSeconds: Math.floor(now() / 1000),
        });
        if (check.valid) return json(200, item.body);

        // 2. No/invalid token -> mint invoice + macaroon, answer 402.
        if (overLimit(clientIp(request, context))) {
            return json(429, { error: 'too many invoice requests, slow down' }, { 'Retry-After': '60' });
        }
        let challenge;
        try {
            challenge = await mintChallenge(item);
        } catch (error) {
            return json(502, { error: `Could not create invoice: ${error.message}` });
        }
        const macaroon = await createMacaroon({
            paymentHash: challenge.paymentHash,
            rootKey,
            resource: id,
            expirySeconds: Math.floor(now() / 1000) + tokenTtlDays * 86_400,
        });
        let header = `L402 macaroon="${macaroon}", invoice="${challenge.paymentRequest}"`;
        // Extension: where the invoice is settled by LNURL (self-custodial
        // owner), tell the widget which LUD-21 verify URL to poll.
        if (challenge.verifyUrl) header += `, verify="${challenge.verifyUrl}"`;
        return json(402, { error: 'payment required' }, { 'WWW-Authenticate': header });
    }

    function describe(request) {
        const origin = publicOrigin(request);
        return {
            blinkPaywall: VERSION,
            username,
            items: Object.values(items).map((item) => ({
                id: item.id,
                title: item.title,
                price: item.price,
                currency: item.currency,
                url: `${origin}${contentPath}${item.id}`,
            })),
        };
    }

    function demoPage(request) {
        const origin = publicOrigin(request);
        const sections = Object.values(items)
            .map((item) => {
                const url = `${origin}${contentPath}${item.id}`;
                const price = formatPrice(item.price, item.currency);
                const snippet = `<div data-blink-paywall data-l402="${url}" data-title="${item.title}"></div>`;
                return `<section class="item">
  <h2>${escapeHtml(item.title)}</h2>
  <p class="muted">${escapeHtml(price)} · verified server-side</p>
  <div data-blink-paywall data-l402="${escapeHtml(url)}" data-title="${escapeHtml(item.title)}" data-description="${escapeHtml(price)} · one-time, verified server-side"></div>
  <p class="muted">Embed this item: <code>${escapeHtml(snippet)}</code></p>
</section>`;
            })
            .join('\n');
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blink Paywall — @${escapeHtml(username)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #1d1d1d; line-height: 1.5; }
  h1 { font-size: 22px; } h2 { font-size: 18px; margin: 0 0 4px; }
  .item { margin: 36px 0; } .muted { color: #6b7280; font-size: 14px; }
  code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 12.5px; overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1>Blink Paywall server — paying <b>@${escapeHtml(username)}</b></h1>
<p class="muted">Your deployment works. Each item below is served only after a verified Lightning payment. Put the script tag once on your own page, then paste an item's embed line wherever the paywall should appear.</p>
<p><code>${escapeHtml(`<script defer src="${WIDGET_URL}"></script>`)}</code></p>
<script defer src="${WIDGET_URL}"></script>
${sections}
</body>
</html>
`;
    }

    async function handle(request, context = {}) {
        const method = request.method.toUpperCase();
        if (method === 'OPTIONS') return respond(204, null);
        if (method !== 'GET' && method !== 'HEAD') {
            return json(405, { error: 'method not allowed' }, { Allow: 'GET, HEAD, OPTIONS' });
        }
        const { pathname } = new URL(request.url);
        if (pathname.startsWith(contentPath)) {
            let id;
            try {
                id = decodeURIComponent(pathname.slice(contentPath.length));
            } catch {
                return json(404, { error: 'unknown content id' });
            }
            if (!ID_PATTERN.test(id)) return json(404, { error: 'unknown content id' });
            return handleContent(request, id, context);
        }
        if (pathname === '/.well-known/blink-paywall.json') return json(200, describe(request));
        if (pathname === '/' || pathname === '/index.html') {
            return respond(200, demoPage(request), { 'Content-Type': 'text/html; charset=utf-8' });
        }
        return json(404, { error: 'not found' });
    }

    return { handle, items, username, version: VERSION };
}
