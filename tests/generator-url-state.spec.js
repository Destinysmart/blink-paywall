/**
 * The generator keeps the whole form in the URL hash so a bookmarked link
 * restores the setup (issue #1).
 *
 * The generator is a plain IIFE meant for a browser, so the specs load the real
 * index.html into jsdom and execute the real generator.js against it — no
 * mocking of the page structure, which would rot the moment the markup changes.
 * `renderPreview()` no-ops when `window.BlinkPaywall` is absent, so these run
 * without building the bundle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const generatorSrc = readFileSync(resolve(__dirname, '../generator.js'), 'utf8');

/** Load the page with an optional starting hash and run the generator on it. */
function loadGenerator(hash = '') {
    const body = html.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '');
    document.body.innerHTML = body;
    window.location.hash = hash;
    new Function(generatorSrc)();
}

const $ = (id) => document.getElementById(id);
const hashParams = () => new URLSearchParams(window.location.hash.replace(/^#/, ''));
const checked = (name) => document.querySelector(`input[name="${name}"]:checked`).value;

/** Flip the mode radio the way a click would. */
function chooseMode(value) {
    const radio = document.querySelector(`input[name="mode"][value="${value}"]`);
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
    vi.useFakeTimers();
    // The generator validates usernames against the Blink API on demand; these
    // specs never assert on that, so keep it quiet and offline.
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
            ok: true,
            json: async () => ({ data: { usernameAvailable: false } }),
        }))
    );
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    window.location.hash = '';
});

describe('restoring from the hash', () => {
    it('applies every field to the form', () => {
        loadGenerator(
            '#type=secret&username=alice&amount=2500&currency=USD&title=My+ebook' +
                '&description=One+time&remember=30d&theme=dark&id=ebook-1' +
                '&unlockClass=supporter&webhook=https%3A%2F%2Fhooks.example%2Fz' +
                '&secret=COUPON-2024'
        );

        expect($('username').value).toBe('alice');
        expect($('amount').value).toBe('2500');
        expect($('currency').value).toBe('USD');
        expect($('title').value).toBe('My ebook');
        expect($('description').value).toBe('One time');
        expect($('remember').value).toBe('30d');
        expect($('theme').value).toBe('dark');
        expect($('item-id').value).toBe('ebook-1');
        expect($('unlock-class').value).toBe('supporter');
        expect($('webhook').value).toBe('https://hooks.example/z');
        expect($('secret-text').value).toBe('COUPON-2024');
        expect(checked('mode')).toBe('soft');
        expect(checked('unlock-type')).toBe('secret');
    });

    it('feeds the restored values into the snippet', () => {
        loadGenerator('#username=alice&amount=2500&currency=USD&title=My+ebook');
        const snippet = $('code').textContent;

        expect(snippet).toContain('data-username="alice"');
        expect(snippet).toContain('data-amount="2500"');
        expect(snippet).toContain('data-currency="USD"');
        expect(snippet).toContain('data-title="My ebook"');
    });

    it('treats a link without a type as the soft setup it was made as', () => {
        // Links saved before hard mode became the default carry no `type`.
        loadGenerator('#username=alice&amount=2500');
        expect(checked('mode')).toBe('soft');
        expect(checked('unlock-type')).toBe('content');
        expect($('code').textContent).toContain('data-username="alice"');
    });

    it('round-trips content through the URL encoding', () => {
        const content = '<p>Hello & welcome — "the full piece"</p>';
        loadGenerator('#content=' + encodeURIComponent(content));

        expect($('content-html').value).toBe(content);
    });

    it('ignores an unknown unlock type and keeps the default', () => {
        loadGenerator('#type=not-a-type');
        expect(checked('mode')).toBe('hard');
    });

    it('ignores unknown params without throwing', () => {
        expect(() => loadGenerator('#bogus=1&username=alice')).not.toThrow();
        expect($('username').value).toBe('alice');
    });

    it('starts from defaults when there is no hash', () => {
        loadGenerator('');
        expect($('username').value).toBe('');
        expect($('amount').value).toBe('1000');
        expect(checked('mode')).toBe('hard');
    });
});

describe('writing the hash', () => {
    it('records edits after the debounce', () => {
        loadGenerator('');
        $('amount').value = '5000';
        $('amount').dispatchEvent(new Event('input', { bubbles: true }));

        expect(hashParams().get('amount')).toBeNull(); // debounced, not yet written
        vi.advanceTimersByTime(300);
        expect(hashParams().get('amount')).toBe('5000');
    });

    it('leaves defaults out so simple setups stay short', () => {
        loadGenerator('');
        $('username').value = 'alice';
        $('username').dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(300);

        const params = hashParams();
        expect(params.get('username')).toBe('alice');
        // Untouched fields keep their defaults and are omitted entirely.
        expect(params.get('amount')).toBeNull();
        expect(params.get('currency')).toBeNull();
        expect(params.get('theme')).toBeNull();
        expect(params.get('title')).toBeNull();
        // Except the type: it is always recorded, so links from before hard
        // mode was the default (which have none) can be told apart.
        expect(params.get('type')).toBe('l402');
    });

    it('records a non-default unlock type', () => {
        loadGenerator('');
        chooseMode('soft');
        const radio = document.querySelector('input[name="unlock-type"][value="redirect"]');
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        vi.advanceTimersByTime(300);

        expect(hashParams().get('type')).toBe('redirect');
    });

    it('survives a full round trip', () => {
        loadGenerator('');
        $('username').value = 'bob';
        $('username').dispatchEvent(new Event('input', { bubbles: true }));
        $('title').value = 'Secret menu';
        $('title').dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(300);
        const saved = window.location.hash;

        loadGenerator(saved);
        expect($('username').value).toBe('bob');
        expect($('title').value).toBe('Secret menu');
    });

    it('uses replaceState so typing does not fill the back button', () => {
        loadGenerator('');
        const push = vi.spyOn(window.history, 'pushState');
        const replace = vi.spyOn(window.history, 'replaceState');

        $('title').value = 'Another';
        $('title').dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(300);

        expect(replace).toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
    });
});

describe('hard mode', () => {
    it('is the default: shows the server step only, and emits data-l402', () => {
        loadGenerator('');
        expect($('server-step').hidden).toBe(false);
        expect($('username-step').hidden).toBe(true);
        expect($('unlock-step').hidden).toBe(true);
        expect($('price-step').hidden).toBe(true);
        expect($('code').textContent).toContain('data-l402="');
        expect($('code').textContent).not.toContain('data-username');
    });

    it('switching to the soft path swaps in its own steps, and back', () => {
        loadGenerator('');
        chooseMode('soft');
        expect($('server-step').hidden).toBe(true);
        expect($('username-step').hidden).toBe(false);
        expect($('unlock-step').hidden).toBe(false);
        expect($('price-step').hidden).toBe(false);
        expect($('code').textContent).toContain('data-username');
        expect($('code').textContent).not.toContain('data-l402');

        chooseMode('hard');
        expect($('server-step').hidden).toBe(false);
        expect($('username-step').hidden).toBe(true);
        expect($('code').textContent).toContain('data-l402="');
    });

    it('checks an endpoint and reports the price from its L402 challenge', async () => {
        vi.useRealTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 402,
                headers: { get: () => 'L402 macaroon="m", invoice="lnbc10u1rest"' },
            }))
        );
        loadGenerator('');
        $('l402-url').value = 'https://paywall.example/content/ebook';
        $('check-l402').click();
        await vi.waitFor(() => expect($('l402-status').textContent).toContain('1000 sats'));
        expect($('l402-status').className).toBe('success');
    });

    it('says so when the URL is not protected', async () => {
        vi.useRealTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null } }))
        );
        loadGenerator('');
        $('l402-url').value = 'https://paywall.example/content/ebook';
        $('check-l402').click();
        await vi.waitFor(() => expect($('l402-status').textContent).toContain('not protected'));
        expect($('l402-status').className).toBe('error');
    });
});

describe('long links', () => {
    it('warns once the link outgrows what chat and mail clients keep', () => {
        loadGenerator('');
        expect($('link-warning').hidden).toBe(true);

        $('content-html').value = '<p>' + 'x'.repeat(2500) + '</p>';
        $('content-html').dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(300);

        expect($('link-warning').hidden).toBe(false);
    });
});
