/**
 * The rich-text editor (editor.js) is a plain browser script; load it into
 * jsdom and drive it through the DOM, the way the generator does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const editorSrc = readFileSync(resolve(__dirname, '../editor.js'), 'utf8');

let textarea;
let editor;

beforeEach(() => {
    document.body.innerHTML =
        '<label for="box">The locked part</label><textarea id="box" placeholder="Write here"></textarea>';
    new Function(editorSrc)();
    textarea = document.getElementById('box');
    editor = window.BlinkEditor.attach(textarea);
});

afterEach(() => {
    document.body.innerHTML = '';
    delete window.BlinkEditor;
});

describe('sanitizeHtml', () => {
    const clean = (html) => window.BlinkEditor.sanitizeHtml(html);

    it('keeps the writing markup and normalises tags', () => {
        expect(clean('<h1>T</h1><div>Hi <b>there</b> and <i>you</i></div>')).toBe(
            '<h2>T</h2>\n<p>Hi <strong>there</strong> and <em>you</em></p>'
        );
        expect(clean('<ul><li>a</li><li>b</li></ul><blockquote>q</blockquote>')).toBe(
            '<ul><li>a</li><li>b</li></ul>\n<blockquote>q</blockquote>'
        );
    });

    it('drops styles, scripts, unknown elements and unsafe links', () => {
        expect(clean('<p style="color:red" class="x" onclick="y()">Hi</p>')).toBe('<p>Hi</p>');
        expect(clean('<p>Hi</p><script>alert(1)</script><style>p{}</style>')).toBe('<p>Hi</p>');
        expect(clean('<p><span data-x="1"><font>plain</font></span></p>')).toBe('<p>plain</p>');
        expect(clean('<p><a href="javascript:alert(1)">bad</a> <a href="https://blink.sv" target="_blank" rel="x">ok</a></p>')).toBe(
            '<p>bad <a href="https://blink.sv">ok</a></p>'
        );
    });

    it('wraps loose text in paragraphs and drops empty ones', () => {
        expect(clean('loose <strong>text</strong>')).toBe('<p>loose <strong>text</strong></p>');
        expect(clean('<p></p><p><br></p><p>kept</p>')).toBe('<p>kept</p>');
        expect(clean('')).toBe('');
    });
});

describe('attach', () => {
    it('builds a toolbar and an editable area, hides the textarea, moves the label', () => {
        const area = document.getElementById('box-editor');
        expect(area.getAttribute('contenteditable')).toBe('true');
        expect(area.getAttribute('data-placeholder')).toBe('Write here');
        expect(textarea.hidden).toBe(true);
        expect(document.querySelector('label').getAttribute('for')).toBe('box-editor');
        const titles = [...document.querySelectorAll('.editor-tool')].map((b) => b.title);
        expect(titles).toEqual(['Heading', 'Normal text', 'Bold', 'Italic', 'Add a link', 'Bulleted list', 'Numbered list', 'Quote']);
    });

    it('writes clean HTML into the textarea as the writer types, and fires input', () => {
        const area = document.getElementById('box-editor');
        let inputs = 0;
        textarea.addEventListener('input', () => inputs++);
        area.innerHTML = '<h1>Part two</h1><div>Paid <b>text</b></div><script>x()</script>';
        area.dispatchEvent(new Event('input', { bubbles: true }));
        expect(textarea.value).toBe('<h2>Part two</h2>\n<p>Paid <strong>text</strong></p>');
        expect(editor.getHtml()).toBe(textarea.value);
        expect(inputs).toBe(1);
    });

    it('follows the textarea when the page changes it', () => {
        textarea.value = '<p>From a <em>link</em></p>';
        textarea.dispatchEvent(new Event('editor:set'));
        expect(document.getElementById('box-editor').innerHTML).toBe('<p>From a <em>link</em></p>');
        editor.setHtml('<p>Set directly</p>');
        expect(textarea.value).toBe('<p>Set directly</p>');
    });
});
