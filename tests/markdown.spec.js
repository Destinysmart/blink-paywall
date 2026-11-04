// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { inline, markdownToHtml } from '../server/markdown.js';

describe('inline', () => {
    it('bold, italic, code, links, images', () => {
        expect(inline('a **b** and *c* and _d_')).toBe('a <strong>b</strong> and <em>c</em> and <em>d</em>');
        expect(inline('x `a < b` y')).toBe('x <code>a &lt; b</code> y');
        expect(inline('[Blink](https://blink.sv)')).toBe('<a href="https://blink.sv">Blink</a>');
        expect(inline('![alt text](/img.png)')).toBe('<img src="/img.png" alt="alt text">');
    });

    it('leaves code spans alone and does not italicise snake_case', () => {
        expect(inline('`**not bold**`')).toBe('<code>**not bold**</code>');
        expect(inline('my_variable_name')).toBe('my_variable_name');
    });
});

describe('markdownToHtml', () => {
    it('headings, paragraphs and rules', () => {
        const html = markdownToHtml('# Title\n\nFirst line\nsecond line\n\n---\n\n## Sub');
        expect(html).toBe('<h1>Title</h1>\n<p>First line second line</p>\n<hr>\n<h2>Sub</h2>');
    });

    it('lists and quotes', () => {
        expect(markdownToHtml('- one\n- two **b**')).toBe('<ul>\n<li>one</li>\n<li>two <strong>b</strong></li>\n</ul>');
        expect(markdownToHtml('1. one\n2) two')).toBe('<ol>\n<li>one</li>\n<li>two</li>\n</ol>');
        expect(markdownToHtml('> quoted\n> *text*')).toBe(
            '<blockquote>\n<p>quoted <em>text</em></p>\n</blockquote>'
        );
    });

    it('fenced code is escaped verbatim', () => {
        expect(markdownToHtml('```\nif (a < b) {}\n```')).toBe('<pre><code>if (a &lt; b) {}</code></pre>');
    });

    it('passes raw HTML lines through', () => {
        const html = markdownToHtml('<iframe src="https://x"></iframe>\n\nAfter');
        expect(html).toBe('<iframe src="https://x"></iframe>\n<p>After</p>');
    });

    it('handles Windows line endings and empty input', () => {
        expect(markdownToHtml('a\r\n\r\nb')).toBe('<p>a</p>\n<p>b</p>');
        expect(markdownToHtml('')).toBe('');
        expect(markdownToHtml(undefined)).toBe('');
    });
});
