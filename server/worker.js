/**
 * Cloudflare Workers entry point.
 *
 *   npx wrangler secret put L402_ROOT_KEY   (value: openssl rand -hex 32)
 *   npx wrangler deploy
 *
 * BLINK_USERNAME / TOKEN_TTL_DAYS / INVOICES_PER_MINUTE / WIDGET_URL are plain
 * vars in wrangler.jsonc. Content comes from content.json plus
 * content.generated.json, which `npm run deploy` builds from the items/ folder
 * (a Worker cannot read files at runtime). An item file wins over a JSON entry
 * with the same id. Items saved from the generator live in the ITEMS KV
 * namespace (provisioned on deploy) and need the ADMIN_PASSWORD secret.
 */

import base from './content.json';
import generated from './content.generated.json';
import { createPaywall } from './paywall.js';
import { createKvStore, createMemoryStore } from './store.js';

const content = { ...base, ...generated };

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
        env.ADMIN_PASSWORD,
        Boolean(env.ITEMS),
    ].join('|');
    if (!paywall || key !== configKey) {
        paywall = createPaywall({
            username: env.BLINK_USERNAME,
            rootKey: env.L402_ROOT_KEY,
            content,
            tokenTtlDays: env.TOKEN_TTL_DAYS,
            invoicesPerMinute: env.INVOICES_PER_MINUTE,
            widgetUrl: env.WIDGET_URL,
            adminPassword: env.ADMIN_PASSWORD,
            // Without the KV binding, saves survive only as long as the isolate.
            store: env.ITEMS ? createKvStore(env.ITEMS) : createMemoryStore(),
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
