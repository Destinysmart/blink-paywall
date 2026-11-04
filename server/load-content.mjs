/**
 * Node-side content loading: content.json plus every file in items/ next to
 * it. Used by node.mjs at boot and by build-content.mjs at deploy time.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildContent, isItemFile } from './items.js';
import { createDocumentStore } from './store.js';

/** Items saved from the generator, kept in a JSON file (default: saved-items.json next to content.json). */
export function createFileStore(filePath) {
    return createDocumentStore(
        async () => {
            try {
                return await readFile(filePath, 'utf8');
            } catch (error) {
                if (error.code === 'ENOENT') return null;
                throw error;
            }
        },
        (text) => writeFile(filePath, text)
    );
}

/** @param {string} dir  the server directory (holds content.json and items/) */
export async function loadContent(dir, { contentFile } = {}) {
    const jsonPath = contentFile || path.join(dir, 'content.json');
    let base = {};
    try {
        base = JSON.parse(await readFile(jsonPath, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return buildContent(base, await readItemFiles(path.join(dir, 'items')));
}

/** Read items/*.md|html; a missing folder is simply no items. */
export async function readItemFiles(itemsDir) {
    let names = [];
    try {
        names = await readdir(itemsDir);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    const files = [];
    for (const name of names.filter(isItemFile).sort()) {
        files.push({ name, text: await readFile(path.join(itemsDir, name), 'utf8') });
    }
    return files;
}
