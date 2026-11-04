/**
 * Where items saved from the generator live. One tiny interface:
 *
 *   list()            -> { id: entry }      every saved item
 *   put(id, entry)    -> void
 *   remove(id)        -> void
 *
 * An entry is the raw shape the generator sends — { title, price, currency,
 * markdown?, html?, redirect? } — validated with normalizeContent before it
 * is stored. Saved items are merged over content.json / items/ at read time.
 *
 * Backends: Workers KV (one JSON document under a single key — a creator has
 * dozens of items, not millions), an in-memory map (tests, or a Worker
 * without the ITEMS binding), and a JSON file for Node / Deno (see the
 * adapters).
 */

export function createMemoryStore(initial = {}) {
    let data = { ...initial };
    return {
        async list() {
            return { ...data };
        },
        async put(id, entry) {
            data = { ...data, [id]: entry };
        },
        async remove(id) {
            const next = { ...data };
            delete next[id];
            data = next;
        },
    };
}

/** @param {{get: Function, put: Function}} namespace  a Workers KV binding */
export function createKvStore(namespace, key = 'items') {
    async function read() {
        const data = await namespace.get(key, 'json');
        return data && typeof data === 'object' ? data : {};
    }
    return {
        list: read,
        async put(id, entry) {
            const data = await read();
            data[id] = entry;
            await namespace.put(key, JSON.stringify(data));
        },
        async remove(id) {
            const data = await read();
            delete data[id];
            await namespace.put(key, JSON.stringify(data));
        },
    };
}

/**
 * A store on top of any read/write-whole-document pair, for files.
 * @param {() => Promise<string|null>} readText   null when the file does not exist
 * @param {(text: string) => Promise<void>} writeText
 */
export function createDocumentStore(readText, writeText) {
    async function read() {
        const text = await readText();
        if (!text) return {};
        try {
            const data = JSON.parse(text);
            return data && typeof data === 'object' ? data : {};
        } catch {
            return {};
        }
    }
    return {
        list: read,
        async put(id, entry) {
            const data = await read();
            data[id] = entry;
            await writeText(JSON.stringify(data, null, 2) + '\n');
        },
        async remove(id) {
            const data = await read();
            delete data[id];
            await writeText(JSON.stringify(data, null, 2) + '\n');
        },
    };
}
