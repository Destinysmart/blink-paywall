/**
 * Deno entry point — `BLINK_USERNAME=you deno run --allow-net --allow-env --allow-read server/deno.js`
 * (also works as-is on Deno Deploy). Same env as node.mjs.
 */

import { buildContent, isItemFile } from './items.js';
import { bytesToHex } from './macaroon.js';
import { createPaywall } from './paywall.js';
import { createDocumentStore } from './store.js';

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
const savedItemsFile =
    Deno.env.get('SAVED_ITEMS_FILE') || new URL('./saved-items.json', import.meta.url);

/** content.json plus every .md / .html file in items/ next to this file. */
async function loadContent() {
    let base = {};
    try {
        base = JSON.parse(await Deno.readTextFile(contentFile));
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const itemsDir = new URL('./items/', import.meta.url);
    const files = [];
    try {
        for await (const entry of Deno.readDir(itemsDir)) {
            if (entry.isFile && isItemFile(entry.name)) files.push(entry.name);
        }
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const loaded = [];
    for (const name of files.sort()) {
        loaded.push({ name, text: await Deno.readTextFile(new URL(name, itemsDir)) });
    }
    return buildContent(base, loaded);
}

const paywall = createPaywall({
    username: Deno.env.get('BLINK_USERNAME'),
    rootKey,
    content: await loadContent(),
    tokenTtlDays: Deno.env.get('TOKEN_TTL_DAYS'),
    invoicesPerMinute: Deno.env.get('INVOICES_PER_MINUTE'),
    widgetUrl: Deno.env.get('WIDGET_URL'),
    adminPassword: Deno.env.get('ADMIN_PASSWORD'),
    store: createDocumentStore(
        async () => {
            try {
                return await Deno.readTextFile(savedItemsFile);
            } catch (error) {
                if (error instanceof Deno.errors.NotFound) return null;
                throw error;
            }
        },
        (text) => Deno.writeTextFile(savedItemsFile, text)
    ),
});

Deno.serve({ port: PORT }, (request, info) =>
    paywall.handle(request, { ip: info.remoteAddr && info.remoteAddr.hostname })
);
