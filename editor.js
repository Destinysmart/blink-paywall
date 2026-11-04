/**
 * A small rich-text editor for the generator — headings, bold, italic, links,
 * lists, quotes — with no dependencies. It sits on top of a <textarea>: the
 * editor is what the writer sees, the textarea keeps the clean HTML the rest
 * of the page reads, so URL state, snippet and saving are unchanged.
 *
 *   BlinkEditor.attach(textarea) -> { setHtml(html), getHtml() }
 *
 * Output is sanitized to a small whitelist (p, h2, h3, strong, em, a[href],
 * ul, ol, li, blockquote, br): pasted content from Word or a web page loses
 * its styles, scripts never get through, links keep only safe hrefs.
 */
(function () {
    'use strict';

    var ALLOWED = {
        p: true, h2: true, h3: true, strong: true, em: true, a: true,
        ul: true, ol: true, li: true, blockquote: true, br: true,
    };
    var RENAME = { b: 'strong', i: 'em', h1: 'h2', h4: 'h3', h5: 'h3', h6: 'h3', div: 'p' };
    var DROP_WITH_CONTENT = { script: true, style: true, iframe: true, object: true, embed: true };

    function safeHref(value) {
        var href = String(value || '').trim();
        return /^(https?:|mailto:|\/|#)/i.test(href) ? href : null;
    }

    /** Rewrite a node tree in place so only whitelisted markup remains. */
    function sanitizeNode(node) {
        var children = Array.prototype.slice.call(node.childNodes);
        children.forEach(function (child) {
            if (child.nodeType === 3) return; // text
            if (child.nodeType !== 1) {
                node.removeChild(child);
                return;
            }
            var tag = child.tagName.toLowerCase();
            if (DROP_WITH_CONTENT[tag]) {
                node.removeChild(child);
                return;
            }
            if (RENAME[tag]) {
                var renamed = document.createElement(RENAME[tag]);
                while (child.firstChild) renamed.appendChild(child.firstChild);
                node.replaceChild(renamed, child);
                child = renamed;
                tag = RENAME[tag];
            }
            if (!ALLOWED[tag]) {
                // Unwrap: keep the content, drop the element.
                while (child.firstChild) node.insertBefore(child.firstChild, child);
                node.removeChild(child);
                return;
            }
            var href = tag === 'a' ? safeHref(child.getAttribute('href')) : null;
            Array.prototype.slice.call(child.attributes).forEach(function (attribute) {
                child.removeAttribute(attribute.name);
            });
            if (tag === 'a') {
                if (!href) {
                    while (child.firstChild) node.insertBefore(child.firstChild, child);
                    node.removeChild(child);
                    return;
                }
                child.setAttribute('href', href);
            }
            sanitizeNode(child);
        });
    }

    function sanitizeHtml(html) {
        var box = document.createElement('div');
        box.innerHTML = html;
        sanitizeNode(box);
        // Loose text at the top level becomes paragraphs.
        var out = [];
        var run = [];
        var flushRun = function () {
            var text = run.map(function (n) { return n.outerHTML || n.textContent; }).join('');
            if (text.replace(/<br>/g, '').trim()) out.push('<p>' + text + '</p>');
            run = [];
        };
        Array.prototype.slice.call(box.childNodes).forEach(function (child) {
            var tag = child.nodeType === 1 ? child.tagName.toLowerCase() : null;
            if (tag && /^(p|h2|h3|ul|ol|blockquote)$/.test(tag)) {
                flushRun();
                if (child.textContent.trim() || tag === 'ul' || tag === 'ol') out.push(child.outerHTML);
            } else {
                run.push(child);
            }
        });
        flushRun();
        return out.join('\n');
    }

    var TOOLS = [
        { label: 'Heading', title: 'Heading', run: function () { block('h2'); } },
        { label: 'Text', title: 'Normal text', run: function () { block('p'); } },
        { label: 'B', title: 'Bold', className: 'bold', run: function () { exec('bold'); } },
        { label: 'I', title: 'Italic', className: 'italic', run: function () { exec('italic'); } },
        { label: 'Link', title: 'Add a link', run: link },
        { label: '• List', title: 'Bulleted list', run: function () { exec('insertUnorderedList'); } },
        { label: '1. List', title: 'Numbered list', run: function () { exec('insertOrderedList'); } },
        { label: 'Quote', title: 'Quote', run: function () { block('blockquote'); } },
    ];

    function exec(command, value) {
        if (document.execCommand) document.execCommand(command, false, value);
    }

    function block(tag) {
        exec('formatBlock', '<' + tag + '>');
    }

    function link() {
        var current = document.queryCommandValue ? document.queryCommandValue('createLink') : '';
        var url = window.prompt('Link address', current || 'https://');
        if (url === null) return;
        var href = safeHref(url);
        if (!href) {
            exec('unlink');
            return;
        }
        exec('createLink', href);
    }

    function attach(textarea) {
        var wrap = document.createElement('div');
        wrap.className = 'editor';

        var toolbar = document.createElement('div');
        toolbar.className = 'editor-toolbar';
        toolbar.setAttribute('role', 'toolbar');
        TOOLS.forEach(function (tool) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'editor-tool' + (tool.className ? ' ' + tool.className : '');
            button.textContent = tool.label;
            button.title = tool.title;
            button.setAttribute('aria-label', tool.title);
            // mousedown + preventDefault keeps the selection in the editable area.
            button.addEventListener('mousedown', function (event) {
                event.preventDefault();
            });
            button.addEventListener('click', function () {
                area.focus();
                tool.run();
                sync();
            });
            toolbar.appendChild(button);
        });

        var area = document.createElement('div');
        area.className = 'editor-area';
        area.contentEditable = 'true';
        area.setAttribute('role', 'textbox');
        area.setAttribute('aria-multiline', 'true');
        if (textarea.placeholder) area.setAttribute('data-placeholder', textarea.placeholder.split('\n')[0]);
        if (textarea.id) {
            area.id = textarea.id + '-editor';
            var label = document.querySelector('label[for="' + textarea.id + '"]');
            if (label) label.setAttribute('for', area.id);
        }

        wrap.appendChild(toolbar);
        wrap.appendChild(area);
        textarea.hidden = true;
        textarea.classList.add('editor-source');
        textarea.parentNode.insertBefore(wrap, textarea.nextSibling);

        var syncing = false;

        /** Editor -> textarea (clean HTML) -> the page's own listeners. */
        function sync() {
            var html = sanitizeHtml(area.innerHTML);
            if (textarea.value === html) return;
            syncing = true;
            textarea.value = html;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            syncing = false;
        }

        /** Textarea -> editor, for content restored from a link or a server. */
        function setHtml(html) {
            var clean = sanitizeHtml(html || '');
            if (area.innerHTML !== clean) area.innerHTML = clean;
            if (textarea.value !== clean) textarea.value = clean;
        }

        area.addEventListener('input', sync);
        area.addEventListener('blur', sync);
        area.addEventListener('paste', function (event) {
            if (!event.clipboardData) return;
            event.preventDefault();
            var html = event.clipboardData.getData('text/html');
            var text = event.clipboardData.getData('text/plain');
            if (html) {
                exec('insertHTML', sanitizeHtml(html));
            } else if (text) {
                var paragraphs = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map(function (p) {
                    return '<p>' + p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</p>';
                });
                exec('insertHTML', paragraphs.join(''));
            }
            sync();
        });
        // Enter inside a heading or quote should start a normal paragraph.
        area.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' || event.shiftKey) return;
            var selection = window.getSelection && window.getSelection();
            var node = selection && selection.anchorNode;
            while (node && node !== area && node.nodeType !== 1) node = node.parentNode;
            while (node && node !== area && !/^(H2|H3|BLOCKQUOTE|P|LI)$/.test(node.tagName)) node = node.parentNode;
            if (node && node !== area && /^(H2|H3)$/.test(node.tagName)) {
                setTimeout(function () {
                    block('p');
                }, 0);
            }
        });
        // Someone else changed the textarea (hash restore, loading a server item).
        textarea.addEventListener('editor:set', function () {
            if (!syncing) setHtml(textarea.value);
        });

        setHtml(textarea.value);
        return { setHtml: setHtml, getHtml: function () { return textarea.value; }, area: area };
    }

    window.BlinkEditor = { attach: attach, sanitizeHtml: sanitizeHtml };
})();
