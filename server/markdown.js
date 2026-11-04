/**
 * A small Markdown-to-HTML converter — enough for articles, zero dependencies.
 *
 * Supported: # headings, paragraphs, **bold**, *italic* / _italic_, `code`,
 * ```fenced code```, [links](url), ![images](src), - lists, 1. lists,
 * > quotes, --- rules, and raw HTML lines (passed through untouched — this is
 * the owner's own content, not visitor input, so nothing is escaped except
 * the inside of code).
 */

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline markup for one block of text. */
export function inline(text) {
    const codes = [];
    let out = text.replace(/`([^`]+)`/g, (match, code) => {
        codes.push(`<code>${escapeHtml(code)}</code>`);
        return `\u0000${codes.length - 1}\u0000`;
    });
    out = out
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
        .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    return out.replace(/\u0000(\d+)\u0000/g, (match, index) => codes[Number(index)]);
}

const LIST_ITEM = /^\s*[-*+]\s+/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+/;

export function markdownToHtml(markdown) {
    const lines = String(markdown || '')
        .replace(/\r\n?/g, '\n')
        .split('\n');
    const out = [];
    let paragraph = [];
    let i = 0;

    const flush = () => {
        if (paragraph.length) {
            out.push(`<p>${inline(paragraph.join(' '))}</p>`);
            paragraph = [];
        }
    };

    while (i < lines.length) {
        const line = lines[i];

        if (/^```/.test(line)) {
            flush();
            const code = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
            i++; // closing fence
            out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
            continue;
        }
        if (!line.trim()) {
            flush();
            i++;
            continue;
        }
        const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
            flush();
            const level = heading[1].length;
            out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
            i++;
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            flush();
            out.push('<hr>');
            i++;
            continue;
        }
        if (/^>/.test(line)) {
            flush();
            const quoted = [];
            while (i < lines.length && /^>/.test(lines[i])) {
                quoted.push(lines[i++].replace(/^>\s?/, ''));
            }
            out.push(`<blockquote>\n${markdownToHtml(quoted.join('\n'))}\n</blockquote>`);
            continue;
        }
        if (LIST_ITEM.test(line) || ORDERED_ITEM.test(line)) {
            flush();
            const ordered = ORDERED_ITEM.test(line);
            const pattern = ordered ? ORDERED_ITEM : LIST_ITEM;
            const items = [];
            while (i < lines.length && pattern.test(lines[i])) {
                items.push(`<li>${inline(lines[i++].replace(pattern, '').trim())}</li>`);
            }
            const tag = ordered ? 'ol' : 'ul';
            out.push(`<${tag}>\n${items.join('\n')}\n</${tag}>`);
            continue;
        }
        if (/^\s*<[a-zA-Z!/]/.test(line)) {
            // Raw HTML: the owner knows what they are doing. Pass the line through.
            flush();
            out.push(line.trim());
            i++;
            continue;
        }
        paragraph.push(line.trim());
        i++;
    }
    flush();
    return out.join('\n');
}
