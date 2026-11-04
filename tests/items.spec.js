// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildContent, isItemFile, parseFrontMatter, parseItemFile } from '../server/items.js';
import { normalizeContent } from '../server/paywall.js';

const STORY = `---
title: Read the rest of this story
price: 500
currency: NGN
---
## Part two

The paid **part**.
`;

describe('parseFrontMatter', () => {
    it('splits the header from the body and strips quotes', () => {
        const { meta, body } = parseFrontMatter('---\ntitle: "Hello: world"\nprice: 10\n---\nBody');
        expect(meta).toEqual({ title: 'Hello: world', price: '10' });
        expect(body).toBe('Body');
    });

    it('treats a file without a header as all body', () => {
        expect(parseFrontMatter('Just text')).toEqual({ meta: {}, body: 'Just text' });
    });
});

describe('parseItemFile', () => {
    it('turns a Markdown file into an html item keyed by its file name', () => {
        const { id, entry } = parseItemFile('my-story.md', STORY);
        expect(id).toBe('my-story');
        expect(entry).toEqual({
            title: 'Read the rest of this story',
            price: 500,
            currency: 'NGN',
            html: '<h2>Part two</h2>\n<p>The paid <strong>part</strong>.</p>',
        });
    });

    it('keeps an .html file as it is', () => {
        const { entry } = parseItemFile('x.html', '---\nprice: 1\n---\n<p>raw</p>');
        expect(entry.html).toBe('<p>raw</p>');
        expect(entry.title).toBeUndefined();
    });

    it('makes a link item from a redirect line', () => {
        const { entry } = parseItemFile('dl.md', '---\ntitle: PDF\nprice: 1000\nredirect: https://x/f.pdf\n---\n');
        expect(entry).toEqual({ title: 'PDF', price: 1000, redirect: 'https://x/f.pdf' });
    });

    it('rejects what the server could not serve, naming the file', () => {
        expect(() => parseItemFile('a.txt', STORY)).toThrow('.md or .html');
        expect(() => parseItemFile('bad name.md', STORY)).toThrow('bad name.md');
        expect(() => parseItemFile('a.md', '---\ntitle: T\n---\nbody')).toThrow('price');
        expect(() => parseItemFile('a.md', '---\nprice: 0\n---\nbody')).toThrow('positive');
        expect(() => parseItemFile('a.md', '---\nprice: 5\n---\n')).toThrow('no content');
    });
});

describe('buildContent', () => {
    it('merges item files over content.json and the result passes server validation', () => {
        const content = buildContent(
            { ebook: { title: 'E', price: 210, html: 'h' }, 'my-story': { price: 1, html: 'old' } },
            [{ name: 'my-story.md', text: STORY }]
        );
        expect(Object.keys(content)).toEqual(['ebook', 'my-story']);
        expect(content['my-story'].price).toBe(500);
        expect(() => normalizeContent(content)).not.toThrow();
    });

    it('isItemFile picks .md / .html and skips dotfiles', () => {
        expect(isItemFile('a.md')).toBe(true);
        expect(isItemFile('a.HTML')).toBe(true);
        expect(isItemFile('.DS_Store')).toBe(false);
        expect(isItemFile('notes.txt')).toBe(false);
    });
});
