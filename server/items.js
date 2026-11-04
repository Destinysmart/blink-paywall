/**
 * Items as files: one Markdown or HTML file per item in `items/`, with the
 * title and price in a short header, so adding an article never means editing
 * JSON. Pure functions — the adapters and the build script do the file I/O.
 *
 *   items/my-story.md
 *   ---
 *   title: Read the rest of this story
 *   price: 500
 *   currency: NGN
 *   ---
 *   The paid part of the article, in Markdown (or HTML in a .html file).
 *
 * A `redirect: https://...` line makes it a link item (download, booking);
 * the body is then optional. The file name is the item id: /content/my-story.
 */

import { markdownToHtml } from './markdown.js';

const EXTENSIONS = { md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html' };

/** Split a leading `---` header off a file. @returns {{meta: object, body: string}} */
export function parseFrontMatter(text) {
    const source = String(text || '').replace(/\r\n?/g, '\n');
    const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
    if (!match) return { meta: {}, body: source };
    const meta = {};
    for (const line of match[1].split('\n')) {
        const pair = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
        if (!pair) continue;
        let value = pair[2];
        if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
        meta[pair[1]] = value;
    }
    return { meta, body: source.slice(match[0].length) };
}

/**
 * Turn one item file into a content entry.
 * @param {string} fileName  e.g. "my-story.md" (the id is the name without extension)
 * @param {string} text      the file's contents
 * @returns {{id: string, entry: object}}
 */
export function parseItemFile(fileName, text) {
    const dot = fileName.lastIndexOf('.');
    const extension = dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
    const kind = EXTENSIONS[extension];
    if (!kind) throw new Error(`items/${fileName}: use a .md or .html file`);
    const id = String(fileName.slice(0, dot)).trim();
    if (!/^[\w-]+$/.test(id)) {
        throw new Error(`items/${fileName}: the file name may only use letters, numbers, "_" and "-"`);
    }

    const { meta, body } = parseFrontMatter(text);
    const entry = {};
    if (meta.title) entry.title = meta.title;
    if (meta.price !== undefined) entry.price = Number(meta.price);
    if (meta.currency) entry.currency = meta.currency;
    if (meta.price === undefined) throw new Error(`items/${fileName}: needs a "price:" line in the header`);
    if (!(entry.price > 0)) throw new Error(`items/${fileName}: the price must be a positive number`);

    if (meta.redirect) {
        entry.redirect = meta.redirect;
    } else {
        const content = body.trim();
        if (!content) throw new Error(`items/${fileName}: the file has no content after the header`);
        entry.html = kind === 'markdown' ? markdownToHtml(content) : content;
    }
    return { id, entry };
}

/**
 * Build the content map from hand-written JSON plus item files. An item file
 * wins over a JSON entry with the same id.
 * @param {object} base   the content.json object (may be empty)
 * @param {Array<{name: string, text: string}>} files
 */
export function buildContent(base, files) {
    const content = { ...(base || {}) };
    for (const file of files) {
        const { id, entry } = parseItemFile(file.name, file.text);
        content[id] = entry;
    }
    return content;
}

/** Which files in a directory listing are item files. */
export function isItemFile(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 && !name.startsWith('.') && Boolean(EXTENSIONS[name.slice(dot + 1).toLowerCase()]);
}
