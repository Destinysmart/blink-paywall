/**
 * Cloudflare Workers entry point.
 *
 *   npx wrangler secret put L402_ROOT_KEY   (value: openssl rand -hex 32)
 *   npx wrangler deploy
 *
 * BLINK_USERNAME / TOKEN_TTL_DAYS / INVOICES_PER_MINUTE / WIDGET_URL are plain
 * vars in wrangler.jsonc; content comes from content.json next to this file.
 */

import content from './content.json';
import { createPaywall } from './paywall.js';

let paywall = null;
let configKey = '';

function instance(env) {
    if (!env.L402_ROOT_KEY) {
        throw new Error(
            'The L402_ROOT_KEY secret is not set. Run: npx wrangler secret put L402_ROOT_KEY  (value: openssl rand -hex 32)'
        );
    }
    const key = [
        env.BLINK_USERNAME,
        env.L402_ROOT_KEY,
        env.TOKEN_TTL_DAYS,
        env.INVOICES_PER_MINUTE,
        env.WIDGET_URL,
    ].join('|');
    if (!paywall || key !== configKey) {
        paywall = createPaywall({
            username: env.BLINK_USERNAME,
            rootKey: env.L402_ROOT_KEY,
            content,
            tokenTtlDays: env.TOKEN_TTL_DAYS,
            invoicesPerMinute: env.INVOICES_PER_MINUTE,
            widgetUrl: env.WIDGET_URL,
        });
        configKey = key;
    }
    return paywall;
}

export default {
    async fetch(request, env) {
        try {
            return await instance(env).handle(request);
        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            });
        }
    },
};
