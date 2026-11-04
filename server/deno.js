/**
 * Deno entry point — `BLINK_USERNAME=you deno run --allow-net --allow-env --allow-read server/deno.js`
 * (also works as-is on Deno Deploy). Same env as node.mjs.
 */

import { bytesToHex } from './macaroon.js';
import { createPaywall } from './paywall.js';

const PORT = Number(Deno.env.get('PORT') || 4402);

let rootKey = Deno.env.get('L402_ROOT_KEY');
if (!rootKey) {
    rootKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    console.warn(
        'No L402_ROOT_KEY set — using a random key; unlocks already sold will not survive a restart.\n' +
            `Set one for production: L402_ROOT_KEY=${rootKey}`
    );
}

const contentFile = Deno.env.get('CONTENT_FILE') || new URL('./content.json', import.meta.url);
const paywall = createPaywall({
    username: Deno.env.get('BLINK_USERNAME'),
    rootKey,
    content: JSON.parse(await Deno.readTextFile(contentFile)),
    tokenTtlDays: Deno.env.get('TOKEN_TTL_DAYS'),
    invoicesPerMinute: Deno.env.get('INVOICES_PER_MINUTE'),
    widgetUrl: Deno.env.get('WIDGET_URL'),
});

Deno.serve({ port: PORT }, (request, info) =>
    paywall.handle(request, { ip: info.remoteAddr && info.remoteAddr.hostname })
);
