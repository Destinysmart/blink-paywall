/**
 * Node entry point — `BLINK_USERNAME=you node server/node.mjs`.
 *
 * Env:
 *   BLINK_USERNAME       required — payments go to this Blink account
 *   L402_ROOT_KEY        64 hex chars; random per boot if unset (old tokens die on restart)
 *   TOKEN_TTL_DAYS       how long a paid unlock stays valid (default 30)
 *   INVOICES_PER_MINUTE  per visitor IP, 0 disables (default 30)
 *   CONTENT_FILE         path to content.json (default: the one next to this file);
 *                        files in the items/ folder next to it are added on top
 *   WIDGET_URL           widget bundle the demo page loads (default: this repo's Pages build)
 *   PORT                 default 4402
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContent } from './load-content.mjs';
import { bytesToHex } from './macaroon.js';
import { createPaywall } from './paywall.js';

const PORT = Number(process.env.PORT || 4402);

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const contentFile = process.env.CONTENT_FILE ? path.resolve(process.env.CONTENT_FILE) : undefined;

let rootKey = process.env.L402_ROOT_KEY;
if (!rootKey) {
    rootKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    console.warn(
        'No L402_ROOT_KEY set — using a random key; unlocks already sold will not survive a restart.\n' +
            `Set one for production: L402_ROOT_KEY=${rootKey}`
    );
}

let paywall;
try {
    paywall = createPaywall({
        username: process.env.BLINK_USERNAME,
        rootKey,
        content: await loadContent(serverDir, { contentFile }),
        tokenTtlDays: process.env.TOKEN_TTL_DAYS,
        invoicesPerMinute: process.env.INVOICES_PER_MINUTE,
        widgetUrl: process.env.WIDGET_URL,
    });
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

function toRequest(req) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const host = req.headers.host || `localhost:${PORT}`;
    return new Request(`http://${host}${req.url}`, { method: req.method, headers });
}

http.createServer(async (req, res) => {
    try {
        const response = await paywall.handle(toRequest(req), { ip: req.socket.remoteAddress });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
        console.error(error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}).listen(PORT, () => {
    const ids = Object.keys(paywall.items).join(', ');
    console.log(`Blink Paywall server for @${paywall.username}: http://localhost:${PORT}/  (items: ${ids})`);
});
