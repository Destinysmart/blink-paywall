// @vitest-environment node
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeMacaroon } from '../server/macaroon.js';
import { createPaywall, formatPrice, normalizeContent, VERSION } from '../server/paywall.js';

const ROOT_KEY = 'aa'.repeat(32);
const ROOT_KEY_BYTES = Buffer.from(ROOT_KEY, 'hex');
const PREIMAGE = 'bb'.repeat(32);
const PAYMENT_HASH = crypto.createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');

// A real Blink invoice (see bolt11.spec.js): the LNURL path must bind ITS hash.
const SPARK_INVOICE =
    'lnbc10u1p4w4ez3pp5uhze229ft4njavxu05thkqszdlch08psq2vplyx3smwkzlszgmxsdp5vfkxjmnt94cxz7thv9kxcgrzdak8gvf3yp6x2um5ypmx2cm5daeqcqzpuxqzuysp5g5e75uhmvxud23neehpdd9z4c37rgn646h4xrl66vzh33a6pk5rq9qxpqysgqtp3f38n60tn29n9q0lw8z9ktn5g4vglr4zp90np9556ks7u8pjj94f6nqehceu4906g7cjcm4c0fn7ptc8qq8fhpjzw2f0sy5cs83ssqqz97hc';
const SPARK_HASH = 'e5c59528a95d672eb0dc7d177b02026ff1779c3002981f90d186dd617e0246cd';

const CONTENT = {
    ebook: { title: 'The Full Article', price: 210, currency: 'sats', html: '<p>paid</p>' },
    download: { title: 'Download', price: 2.5, currency: 'USD', redirect: 'https://x.example/f' },
};

function jsonResponse(value, init = {}) {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...init,
    });
}

/**
 * A fake Blink: custodial wallet of `walletCurrency` (null = self-custodial),
 * a fixed rate, and a log of every call so tests can assert on the mutation
 * and the amount that were used.
 */
function fakeBlink({ walletCurrency = 'BTC', satPriceCents = 0.1, failInvoices = false } = {}) {
    const calls = [];
    const fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.includes('graphql')) {
            const body = JSON.parse(options.body);
            calls.push(body);
            if (body.query.includes('accountDefaultWallet')) {
                return walletCurrency
                    ? jsonResponse({
                          data: { accountDefaultWallet: { id: 'w1', currency: walletCurrency } },
                      })
                    : jsonResponse({ data: null, errors: [{ message: 'Account does not exist' }] });
            }
            if (body.query.includes('realtimePrice')) {
                return jsonResponse({
                    data: {
                        realtimePrice: {
                            btcSatPrice: { base: Math.round(satPriceCents * 100), offset: 2 },
                            usdCentPrice: { base: 100, offset: 2 },
                        },
                    },
                });
            }
            if (failInvoices) {
                return jsonResponse({ data: null, errors: [{ message: 'Rate limit exceeded' }] });
            }
            const name = /\$input: (\w+)Input!/.exec(body.query)[1];
            const mutation = name[0].toLowerCase() + name.slice(1);
            return jsonResponse({
                data: {
                    [mutation]: {
                        invoice: { paymentRequest: 'lnbc2100n1fake', paymentHash: PAYMENT_HASH },
                        errors: [],
                    },
                },
            });
        }
        if (target.includes('.well-known/lnurlp/')) {
            calls.push({ lnurl: target });
            return jsonResponse({
                tag: 'payRequest',
                callback: 'https://lnurl.blink.sv/lnurlp/blink.sv/alice/invoice',
                minSendable: 1000,
                maxSendable: 1e11,
                commentAllowed: 255,
            });
        }
        if (target.includes('/invoice?')) {
            calls.push({ lnurl: target });
            return jsonResponse({ pr: SPARK_INVOICE, verify: 'https://lnurl.blink.sv/verify/abc' });
        }
        throw new Error('unexpected fetch ' + target);
    };
    return { fetch, calls };
}

function paywall(overrides = {}, blinkOptions = {}) {
    const blink = fakeBlink(blinkOptions);
    const instance = createPaywall({
        username: 'alice',
        rootKey: ROOT_KEY,
        content: CONTENT,
        fetch: blink.fetch,
        ...overrides,
    });
    return { instance, calls: blink.calls };
}

const get = (url, headers = {}) => new Request(url, { headers });

function challengeOf(response) {
    const header = response.headers.get('WWW-Authenticate');
    const macaroon = /macaroon="([^"]+)"/.exec(header)[1];
    const invoice = /invoice="([^"]+)"/.exec(header)[1];
    const verify = /verify="([^"]+)"/.exec(header);
    return { header, macaroon, invoice, verify: verify ? verify[1] : null };
}

describe('normalizeContent', () => {
    it('reads price + currency, html / redirect / response bodies', () => {
        const items = normalizeContent({
            a: { price: 2.5, currency: 'usd', html: '<p>x</p>' },
            b: { price: '1000', redirect: 'https://x' },
            c: { title: 'C', price: 1, currency: 'sats', response: { custom: true } },
        });
        expect(items.a).toEqual({
            id: 'a',
            title: 'a',
            price: 2.5,
            currency: 'USD',
            body: { html: '<p>x</p>' },
        });
        expect(items.b.body).toEqual({ redirect: 'https://x' });
        expect(items.b.currency).toBe('sats');
        expect(items.c.body).toEqual({ custom: true });
        expect(items.c.title).toBe('C');
    });

    it('still accepts the v0.1 server shape (priceSats + body)', () => {
        const items = normalizeContent({ ebook: { priceSats: 210, body: { html: 'h' } } });
        expect(items.ebook).toMatchObject({ price: 210, currency: 'sats', body: { html: 'h' } });
    });

    it('fails at boot on broken config', () => {
        expect(() => normalizeContent(null)).toThrow('object');
        expect(() => normalizeContent({ 'bad id': { price: 1, html: 'x' } })).toThrow('bad id');
        expect(() => normalizeContent({ a: { price: 0, html: 'x' } })).toThrow('positive price');
        expect(() => normalizeContent({ a: { price: 1 } })).toThrow('html, redirect or response');
    });

    it('formatPrice', () => {
        expect(formatPrice(210, 'sats')).toBe('210 sats');
        expect(formatPrice(2.5, 'USD')).toBe('$2.50');
    });
});

describe('createPaywall config', () => {
    it('requires a username and a 32-byte root key', () => {
        expect(() => createPaywall({ rootKey: ROOT_KEY, content: CONTENT })).toThrow(
            'BLINK_USERNAME'
        );
        expect(() => createPaywall({ username: 'a', rootKey: 'short', content: CONTENT })).toThrow(
            'L402_ROOT_KEY'
        );
        expect(() =>
            createPaywall({ username: 'a', rootKey: ROOT_KEY_BYTES, content: CONTENT })
        ).not.toThrow();
    });

    it('normalizes the username', () => {
        expect(paywall({ username: ' @Alice ' }).instance.username).toBe('alice');
    });
});

describe('L402 flow (custodial owner)', () => {
    it('answers an unauthorized GET with a 402 + macaroon bound to the invoice', async () => {
        const { instance, calls } = paywall();
        const response = await instance.handle(get('https://pay.example/content/ebook'));
        expect(response.status).toBe(402);
        expect(response.headers.get('Access-Control-Expose-Headers')).toContain('WWW-Authenticate');
        expect(response.headers.get('Cache-Control')).toBe('no-store');

        const { header, macaroon, invoice, verify } = challengeOf(response);
        expect(header).toMatch(/^L402 macaroon="/);
        expect(invoice).toBe('lnbc2100n1fake');
        expect(verify).toBeNull();
        const decoded = await decodeMacaroon({ macaroon, rootKey: ROOT_KEY_BYTES });
        expect(decoded.signatureValid).toBe(true);
        expect(decoded.paymentHash).toBe(PAYMENT_HASH);
        expect(decoded.resource).toBe('ebook');
        expect(decoded.expiresAt).toBeGreaterThan(Date.now() / 1000 + 29 * 86_400);

        const mint = calls.find((call) => call.query && call.query.includes('CreateInvoice'));
        expect(mint.query).toContain('lnInvoiceCreateOnBehalfOfRecipient');
        expect(mint.variables.input).toMatchObject({
            recipientWalletId: 'w1',
            amount: '210',
            memo: 'Unlock: The Full Article',
            expiresIn: '15',
        });
    });

    it('releases the content for macaroon:preimage, and only for that resource', async () => {
        const { instance } = paywall();
        const { macaroon } = challengeOf(
            await instance.handle(get('https://pay.example/content/ebook'))
        );
        const token = `L402 ${macaroon}:${PREIMAGE}`;

        const paid = await instance.handle(
            get('https://pay.example/content/ebook', { Authorization: token })
        );
        expect(paid.status).toBe(200);
        expect(await paid.json()).toEqual({ html: '<p>paid</p>' });

        const other = await instance.handle(
            get('https://pay.example/content/download', { Authorization: token })
        );
        expect(other.status).toBe(402);

        const wrongPreimage = await instance.handle(
            get('https://pay.example/content/ebook', {
                Authorization: `L402 ${macaroon}:${'cc'.repeat(32)}`,
            })
        );
        expect(wrongPreimage.status).toBe(402);
    });

    it('expires tokens after TOKEN_TTL_DAYS', async () => {
        let clock = Date.now();
        const { instance } = paywall({ tokenTtlDays: 1, now: () => clock });
        const { macaroon } = challengeOf(
            await instance.handle(get('https://pay.example/content/ebook'))
        );
        const token = `L402 ${macaroon}:${PREIMAGE}`;
        clock += 2 * 86_400_000;
        const response = await instance.handle(
            get('https://pay.example/content/ebook', { Authorization: token })
        );
        expect(response.status).toBe(402);
    });

    it('fiat price into a USD wallet: cents mutation, no rate lookup', async () => {
        const { instance, calls } = paywall({}, { walletCurrency: 'USD' });
        await instance.handle(get('https://pay.example/content/download'));
        const mint = calls.find((call) => call.query && call.query.includes('CreateInvoice'));
        expect(mint.query).toContain('lnUsdInvoiceCreateOnBehalfOfRecipient');
        expect(mint.variables.input).toMatchObject({ amount: '250', expiresIn: '5' });
        expect(calls.some((call) => call.query && call.query.includes('realtimePrice'))).toBe(false);
    });

    it('sats price into a USD wallet: exact sats via the BTC-denominated mutation', async () => {
        const { instance, calls } = paywall({}, { walletCurrency: 'USD' });
        await instance.handle(get('https://pay.example/content/ebook'));
        const mint = calls.find((call) => call.query && call.query.includes('CreateInvoice'));
        expect(mint.query).toContain('lnUsdInvoiceBtcDenominatedCreateOnBehalfOfRecipient');
        expect(mint.variables.input.amount).toBe('210');
    });

    it('fiat price into a BTC wallet converts at the realtime rate', async () => {
        const { instance, calls } = paywall({}, { walletCurrency: 'BTC', satPriceCents: 0.1 });
        await instance.handle(get('https://pay.example/content/download'));
        expect(calls.some((call) => call.query && call.query.includes('realtimePrice'))).toBe(true);
        const mint = calls.find((call) => call.query && call.query.includes('CreateInvoice'));
        expect(mint.variables.input.amount).toBe('2500'); // $2.50 at 0.1 cent/sat
    });

    it('looks the wallet up once, not per visitor', async () => {
        const { instance, calls } = paywall();
        await instance.handle(get('https://pay.example/content/ebook'));
        await instance.handle(get('https://pay.example/content/ebook'));
        const lookups = calls.filter((call) => call.query && call.query.includes('DefaultWallet'));
        expect(lookups).toHaveLength(1);
    });

    it('reports a Blink failure as 502, not a crash', async () => {
        const { instance } = paywall({}, { failInvoices: true });
        const response = await instance.handle(get('https://pay.example/content/ebook'));
        expect(response.status).toBe(502);
        expect((await response.json()).error).toContain('Rate limit exceeded');
    });
});

describe('L402 flow (self-custodial owner)', () => {
    it('mints via LNURL-pay, binds the invoice hash, advertises the verify URL', async () => {
        const { instance, calls } = paywall({}, { walletCurrency: null });
        const response = await instance.handle(get('https://pay.example/content/ebook'));
        expect(response.status).toBe(402);

        const { macaroon, invoice, verify } = challengeOf(response);
        expect(invoice).toBe(SPARK_INVOICE);
        expect(verify).toBe('https://lnurl.blink.sv/verify/abc');
        const decoded = await decodeMacaroon({ macaroon, rootKey: ROOT_KEY_BYTES });
        expect(decoded.paymentHash).toBe(SPARK_HASH);

        const callback = calls.find((call) => call.lnurl && call.lnurl.includes('/invoice?'));
        const params = new URL(callback.lnurl).searchParams;
        expect(params.get('amount')).toBe('210000');
        expect(params.get('comment')).toBe('Unlock: The Full Article');
    });

    it('converts a fiat price to sats for the LNURL invoice', async () => {
        const { instance, calls } = paywall({}, { walletCurrency: null, satPriceCents: 0.1 });
        await instance.handle(get('https://pay.example/content/download'));
        const callback = calls.find((call) => call.lnurl && call.lnurl.includes('/invoice?'));
        expect(new URL(callback.lnurl).searchParams.get('amount')).toBe('2500000');
    });
});

describe('abuse guard', () => {
    it('limits unpaid invoices per visitor IP and answers 429', async () => {
        const { instance } = paywall({ invoicesPerMinute: 2 });
        const url = 'https://pay.example/content/ebook';
        expect((await instance.handle(get(url), { ip: '1.1.1.1' })).status).toBe(402);
        expect((await instance.handle(get(url), { ip: '1.1.1.1' })).status).toBe(402);
        const limited = await instance.handle(get(url), { ip: '1.1.1.1' });
        expect(limited.status).toBe(429);
        expect(limited.headers.get('Retry-After')).toBe('60');
        // Another visitor is unaffected; the proxy header is honoured too.
        expect((await instance.handle(get(url), { ip: '2.2.2.2' })).status).toBe(402);
        expect(
            (await instance.handle(get(url, { 'cf-connecting-ip': '3.3.3.3' }))).status
        ).toBe(402);
    });

    it('a valid token is never rate limited', async () => {
        const { instance } = paywall({ invoicesPerMinute: 1 });
        const url = 'https://pay.example/content/ebook';
        const { macaroon } = challengeOf(await instance.handle(get(url), { ip: '1.1.1.1' }));
        const token = `L402 ${macaroon}:${PREIMAGE}`;
        for (let i = 0; i < 3; i++) {
            const response = await instance.handle(get(url, { Authorization: token }), {
                ip: '1.1.1.1',
            });
            expect(response.status).toBe(200);
        }
    });

    it('can be switched off', async () => {
        const { instance } = paywall({ invoicesPerMinute: 0 });
        for (let i = 0; i < 5; i++) {
            const response = await instance.handle(get('https://pay.example/content/ebook'));
            expect(response.status).toBe(402);
        }
    });
});

describe('routing', () => {
    it('CORS preflight, method guard, unknown ids', async () => {
        const { instance } = paywall();
        const preflight = await instance.handle(
            new Request('https://pay.example/content/ebook', { method: 'OPTIONS' })
        );
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');

        const post = await instance.handle(
            new Request('https://pay.example/content/ebook', { method: 'POST' })
        );
        expect(post.status).toBe(405);

        expect((await instance.handle(get('https://pay.example/content/nope'))).status).toBe(404);
        expect((await instance.handle(get('https://pay.example/content/a%2Fb'))).status).toBe(404);
        expect((await instance.handle(get('https://pay.example/content/'))).status).toBe(404);
        expect((await instance.handle(get('https://pay.example/elsewhere'))).status).toBe(404);
    });

    it('serves a demo page and a machine-readable item list', async () => {
        const { instance } = paywall();
        const page = await instance.handle(get('https://pay.example/'));
        expect(page.status).toBe(200);
        expect(page.headers.get('Content-Type')).toContain('text/html');
        const html = await page.text();
        expect(html).toContain('data-l402="https://pay.example/content/ebook"');
        expect(html).toContain('data-l402="https://pay.example/content/download"');
        expect(html).toContain('@alice');

        const list = await instance.handle(get('https://pay.example/.well-known/blink-paywall.json'));
        expect(list.status).toBe(200);
        expect(await list.json()).toEqual({
            blinkPaywall: VERSION,
            username: 'alice',
            items: [
                {
                    id: 'ebook',
                    title: 'The Full Article',
                    price: 210,
                    currency: 'sats',
                    url: 'https://pay.example/content/ebook',
                },
                {
                    id: 'download',
                    title: 'Download',
                    price: 2.5,
                    currency: 'USD',
                    url: 'https://pay.example/content/download',
                },
            ],
        });
    });

    it('builds public URLs from the proxy headers in front of Node', async () => {
        const { instance } = paywall();
        const list = await instance.handle(
            get('http://localhost:4402/.well-known/blink-paywall.json', {
                'x-forwarded-proto': 'https',
                'x-forwarded-host': 'paywall.example.com',
            })
        );
        expect((await list.json()).items[0].url).toBe('https://paywall.example.com/content/ebook');
    });

    it('escapes item titles on the demo page', async () => {
        const { instance } = paywall({
            content: { x: { title: '<img src=x onerror=alert(1)>', price: 1, html: 'h' } },
        });
        const html = await (await instance.handle(get('https://pay.example/'))).text();
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img src=x');
    });
});
