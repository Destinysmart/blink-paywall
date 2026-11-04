/**
 * The paywall card — rendering only, no payment logic.
 *
 * Rendered inside a shadow root for CSS isolation. The paywall instance
 * drives it through explicit state methods (showLocked, showInvoice, ...);
 * the view reports user intent back through the handlers it was given:
 *   onUnlock()             visitor clicked "Unlock"
 *   onRetry()              visitor clicked "Try again"
 *   onPreimage(preimage)   a WebLN wallet paid and returned the preimage
 */

import qrcode from './qr.js';
import css from './styles.css';

export const VERSION = '0.2.0';

const BRAND_URL =
    'https://get.blink.sv?referral=blink_paywall&widget_version=' + encodeURIComponent(VERSION);

const ICONS = {
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12.5 2.5 2.5L16 9.5"/></svg>',
    zap: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>',
};

/** "2100 sats", "$2.50", "€2.50" — Intl gets each currency's decimals right. */
export function formatPrice(amount, currency) {
    if (currency === 'sats') return `${amount} sats`;
    const code = String(currency).toUpperCase();
    try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(
            amount
        );
    } catch {
        return `${amount} ${code}`;
    }
}

export function buildQrDataUrl(text) {
    try {
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        return qr.createDataURL(4, 8);
    } catch {
        return null;
    }
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function icon(name, extraClass = '') {
    const wrap = el('div', `icon ${extraClass}`.trim());
    wrap.innerHTML = ICONS[name];
    return wrap;
}

function isMobile() {
    return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function createView(container, config, handlers) {
    const host = el('div');
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    container.prepend(host);

    const style = document.createElement('style');
    style.textContent = css;
    root.appendChild(style);

    // 'auto' (default) follows prefers-color-scheme in CSS; 'light'/'dark' pin it.
    const themeClass = { dark: 'dark', light: '' }[config.theme] ?? 'auto';
    const card = el('div', `card ${themeClass}`.trim());
    const body = el('div', 'body');
    card.appendChild(body);

    const brand = el('a', 'brand');
    brand.href = BRAND_URL;
    brand.target = '_blank';
    brand.rel = 'noopener noreferrer';
    brand.append('Powered by ', Object.assign(el('b'), { textContent: 'Blink' }));
    card.appendChild(brand);
    root.appendChild(card);

    let countdownTimer = null;

    function clearCountdown() {
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
    }

    function setBody(...nodes) {
        clearCountdown();
        body.replaceChildren(...nodes);
    }

    function header() {
        const nodes = [];
        if (config.title) nodes.push(el('h3', 'title', config.title));
        if (config.description) nodes.push(el('p', 'desc', config.description));
        return nodes;
    }

    const view = {
        host,

        showLocked(priceLabel) {
            const text = priceLabel ? `Unlock for ${priceLabel}` : 'Unlock with Lightning';
            const button = el('button', 'btn primary', text);
            button.addEventListener('click', handlers.onUnlock);
            setBody(icon('lock'), ...header(), button);
        },

        showWorking(message = 'Creating invoice\u2026') {
            setBody(el('div', 'spinner'), el('p', 'status', message));
        },

        /**
         * @param {{paymentRequest: string, expiresAt?: number}} challenge
         */
        showInvoice(challenge, priceLabel) {
            const { paymentRequest, expiresAt } = challenge;
            const nodes = [...header()];

            const link = el('a', 'qr');
            link.href = `lightning:${paymentRequest}`;
            const dataUrl = buildQrDataUrl(paymentRequest.toUpperCase());
            if (dataUrl) {
                const img = document.createElement('img');
                img.src = dataUrl;
                img.alt = 'Lightning invoice QR code';
                link.appendChild(img);
            } else {
                link.textContent = 'Open in wallet';
            }
            nodes.push(el('p', 'desc', `Pay ${priceLabel} to unlock`), link);

            const countdown = el('div', 'countdown');
            if (expiresAt) {
                const render = () => {
                    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
                    const minutes = String(Math.floor(left / 60));
                    const seconds = String(left % 60).padStart(2, '0');
                    countdown.textContent = `Expires in ${minutes}:${seconds}`;
                    if (left <= 0) clearCountdown();
                };
                render();
                countdownTimer = setInterval(render, 1000);
            }
            nodes.push(countdown);

            const status = el('p', 'status');
            const payButton = el('button', 'btn primary', 'Pay in wallet');
            payButton.addEventListener('click', async () => {
                // WebLN first (also the only settlement path for non-Blink
                // L402 invoices), then lightning: deeplink, then clipboard.
                if (window.webln) {
                    try {
                        await window.webln.enable();
                        const result = await window.webln.sendPayment(paymentRequest);
                        if (result && result.preimage) {
                            handlers.onPreimage(result.preimage);
                            return;
                        }
                    } catch {}
                }
                if (isMobile()) {
                    window.open(`lightning:${paymentRequest}`, '_self');
                    return;
                }
                copy();
            });

            const copyButton = el('button', 'btn ghost', 'Copy invoice');
            const copy = () => {
                navigator.clipboard
                    .writeText(paymentRequest)
                    .then(
                        () => (status.textContent = 'Invoice copied \u2014 paste it in your wallet')
                    )
                    .catch(() => (status.textContent = paymentRequest));
            };
            copyButton.addEventListener('click', copy);

            nodes.push(payButton, copyButton, status);
            setBody(...nodes);
        },

        showPaid() {
            setBody(icon('check', 'success'), el('p', 'title', 'Payment received'));
        },

        showExpired() {
            const button = el('button', 'btn primary', 'Try again');
            button.addEventListener('click', handlers.onRetry);
            setBody(...header(), el('p', 'desc', 'The invoice expired.'), button);
        },

        showError(message) {
            const button = el('button', 'btn primary', 'Try again');
            button.addEventListener('click', handlers.onRetry);
            setBody(...header(), el('p', 'desc', message || 'Something went wrong.'), button);
        },

        destroy() {
            clearCountdown();
            host.remove();
        },
    };

    return view;
}
