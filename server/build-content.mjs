/**
 * Deploy-time step for Cloudflare Workers: a Worker cannot read files, so the
 * items/ folder is compiled into content.generated.json, which worker.js
 * imports next to content.json. Runs automatically from `npm run deploy`.
 *
 *   node server/build-content.mjs
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readItemFiles } from './load-content.mjs';
import { buildContent } from './items.js';
import { normalizeContent } from './paywall.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(dir, 'content.generated.json');

try {
    const files = await readItemFiles(path.join(dir, 'items'));
    const generated = buildContent({}, files);
    normalizeContent(generated); // same validation the server applies at boot
    await writeFile(target, JSON.stringify(generated, null, 2) + '\n');
    const ids = Object.keys(generated);
    console.log(
        ids.length
            ? `content.generated.json: ${ids.length} item(s) from items/ — ${ids.join(', ')}`
            : 'content.generated.json: no files in items/ (content.json alone is used)'
    );
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
