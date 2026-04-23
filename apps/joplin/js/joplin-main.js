/*!
 * Joplin — Nextcloud app (frontend SPA, vanilla JS, no build step)
 *
 *  - Fetches the notebook/notes index from /apps/joplin/api/tree
 *  - Loads single notes from /apps/joplin/api/note/{id}
 *  - Full-text search via /apps/joplin/api/search?q=...
 *  - Renders a small, dependency-free subset of Markdown
 */
(function () {
    'use strict';

    // ---------- Utilities ---------------------------------------------------

    function el(tag, attrs, children) {
        const node = document.createElement(tag);
        if (attrs) {
            for (const k in attrs) {
                if (k === 'class') node.className = attrs[k];
                else if (k === 'text') node.textContent = attrs[k];
                else if (k === 'html') node.innerHTML = attrs[k];
                else if (k.startsWith('on') && typeof attrs[k] === 'function') {
                    node.addEventListener(k.substring(2), attrs[k]);
                } else if (attrs[k] !== undefined && attrs[k] !== null) {
                    node.setAttribute(k, attrs[k]);
                }
            }
        }
        (children || []).forEach(function (c) {
            if (c == null) return;
            node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return node;
    }

    function escHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatDate(v) {
        if (!v) return '';
        // Joplin uses ISO strings; file mtime is a unix int.
        const d = typeof v === 'number'
            ? new Date(v * 1000)
            : new Date(v);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleString();
    }

    /** Notes-style relative time: "2 minutes ago", "yesterday", "3 days ago". */
    function relativeDate(v) {
        if (!v) return '';
        const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v);
        if (isNaN(d.getTime())) return '';
        const diff = (Date.now() - d.getTime()) / 1000;
        if (diff < 60)        return 'just now';
        if (diff < 3600)      return Math.floor(diff / 60) + ' min ago';
        if (diff < 86400)     return Math.floor(diff / 3600) + ' hr ago';
        if (diff < 2 * 86400) return 'yesterday';
        if (diff < 7 * 86400) return Math.floor(diff / 86400) + ' days ago';
        if (diff < 30 * 86400)return Math.floor(diff / (7 * 86400)) + ' wk ago';
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function apiUrl(path) {
        if (window.OC && typeof OC.generateUrl === 'function') {
            return OC.generateUrl('/apps/joplin' + path);
        }
        return '/apps/joplin' + path;
    }

    function requestHeaders(extra) {
        const h = Object.assign({ 'Accept': 'application/json' }, extra || {});
        if (window.OC && OC.requestToken) {
            h['requesttoken'] = OC.requestToken;
        }
        return h;
    }

    function fetchJson(url, opts) {
        opts = opts || {};
        opts.headers = requestHeaders(opts.headers);
        opts.credentials = 'include';
        // Always defeat browser/proxy caching — we want fresh filesystem data.
        opts.cache = 'no-store';
        const sep = url.indexOf('?') === -1 ? '?' : '&';
        const bustedUrl = url + sep + '_t=' + Date.now();
        return fetch(bustedUrl, opts).then(function (r) {
            if (!r.ok) {
                return r.json().catch(function () { return {}; })
                    .then(function (body) {
                        const err = new Error(body.error || ('HTTP ' + r.status));
                        err.status = r.status;
                        err.body = body;
                        throw err;
                    });
            }
            return r.json();
        });
    }

    // ---------- Minimal Markdown renderer ----------------------------------
    // Supports: headings, paragraphs, bold/italic, inline code, code fences,
    // unordered/ordered lists, blockquotes, hr, links, images, line breaks.

    function renderMarkdown(md) {
        if (!md) return '';
        md = String(md).replace(/\r\n?/g, '\n');

        // Extract fenced code blocks first to protect them from further processing.
        const codeBlocks = [];
        md = md.replace(/```([\w-]*)\n([\s\S]*?)\n```/g, function (_m, lang, code) {
            codeBlocks.push({ lang: lang, code: code });
            return '\u0000CB' + (codeBlocks.length - 1) + '\u0000';
        });

        const lines = md.split('\n');
        const out = [];
        let i = 0;

        function inline(s) {
            s = escHtml(s);
            // Inline code
            s = s.replace(/`([^`]+)`/g, function (_m, c) {
                return '<code>' + c + '</code>';
            });
            // Images ![alt](src)
            s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
                function (_m, alt, src, title) {
                    const t = title ? ' title="' + title + '"' : '';
                    return '<img alt="' + alt + '" src="' + src + '"' + t + '>';
                });
            // Links [text](url)
            s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
                function (_m, txt, href) {
                    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>';
                });
            // Bold
            s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
            // Italic
            s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
            s = s.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
            return s;
        }

        while (i < lines.length) {
            const line = lines[i];

            // Placeholder for extracted code block
            const cb = /^\u0000CB(\d+)\u0000$/.exec(line.trim());
            if (cb) {
                const b = codeBlocks[+cb[1]];
                out.push('<pre><code' + (b.lang ? ' class="language-' + escHtml(b.lang) + '"' : '') +
                    '>' + escHtml(b.code) + '</code></pre>');
                i++;
                continue;
            }

            // Blank line
            if (line.trim() === '') { i++; continue; }

            // Heading
            const h = /^(#{1,6})\s+(.*)$/.exec(line);
            if (h) {
                const lvl = h[1].length;
                out.push('<h' + lvl + '>' + inline(h[2].trim()) + '</h' + lvl + '>');
                i++;
                continue;
            }

            // Horizontal rule
            if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
                out.push('<hr>');
                i++;
                continue;
            }

            // Blockquote (contiguous > lines)
            if (/^\s*>\s?/.test(line)) {
                const buf = [];
                while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
                    buf.push(lines[i].replace(/^\s*>\s?/, ''));
                    i++;
                }
                out.push('<blockquote>' + renderMarkdown(buf.join('\n')) + '</blockquote>');
                continue;
            }

            // Unordered list
            if (/^\s*[-*+]\s+/.test(line)) {
                const items = [];
                while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
                    items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
                    i++;
                }
                out.push('<ul>' + items.map(function (t) {
                    return '<li>' + inline(t) + '</li>';
                }).join('') + '</ul>');
                continue;
            }

            // Ordered list
            if (/^\s*\d+\.\s+/.test(line)) {
                const items = [];
                while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
                    items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
                    i++;
                }
                out.push('<ol>' + items.map(function (t) {
                    return '<li>' + inline(t) + '</li>';
                }).join('') + '</ol>');
                continue;
            }

            // Paragraph (consume until blank line)
            const para = [];
            while (i < lines.length && lines[i].trim() !== '' &&
                   !/^(#{1,6})\s+/.test(lines[i]) &&
                   !/^\s*>\s?/.test(lines[i]) &&
                   !/^\s*[-*+]\s+/.test(lines[i]) &&
                   !/^\s*\d+\.\s+/.test(lines[i]) &&
                   !/^\u0000CB\d+\u0000$/.test(lines[i].trim())) {
                para.push(lines[i]);
                i++;
            }
            out.push('<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
        }

        return out.join('\n');
    }

    // ---------- State & rendering ------------------------------------------

    const state = {
        folders: {},      // id -> folder
        notes: {},        // id -> note meta
        childFolders: {}, // parent_id (or '__ROOT__') -> [folder]
        notesInFolder: {},// parent_id (or '__ROOT__') -> [note]
        selectedFolder: '__ALL__',
        selectedNote: null,
        expanded: {},     // folderId -> bool
        searchQuery: '',
        searchResults: null, // null when not searching
        editing: false,      // true when editor (new or edit) is active
        editingDraft: null,  // { id|null, parent_id, isNew, content } — Notes-style: title is first heading line of `content`
        saving: false,
        deleting: false,
        previewMode: false,  // toolbar Preview toggle in the editor
    };

    function groupIndex(folders, notes) {
        state.folders = {};
        state.notes = {};
        state.childFolders = { __ROOT__: [] };
        state.notesInFolder = { __ROOT__: [] };

        folders.forEach(function (f) {
            state.folders[f.id] = f;
            const p = f.parent_id || '__ROOT__';
            (state.childFolders[p] = state.childFolders[p] || []).push(f);
        });
        notes.forEach(function (n) {
            state.notes[n.id] = n;
            const p = n.parent_id || '__ROOT__';
            (state.notesInFolder[p] = state.notesInFolder[p] || []).push(n);
        });
        // Sort alphabetically / by mtime desc
        Object.values(state.childFolders).forEach(function (arr) {
            arr.sort(function (a, b) { return a.title.localeCompare(b.title); });
        });
        Object.values(state.notesInFolder).forEach(function (arr) {
            arr.sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); });
        });
    }

    function renderTree(root) {
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'joplin-tree-title', text: 'Notebooks' }));

        const ul = el('ul');
        ul.appendChild(treeItem({ id: '__ALL__', title: 'All notes', parent_id: null }, 0, true));

        function addChildren(parent, depth, ulEl) {
            const kids = state.childFolders[parent] || [];
            kids.forEach(function (f) {
                ulEl.appendChild(treeItem(f, depth, false));
                if (state.expanded[f.id]) {
                    const sub = el('ul');
                    addChildren(f.id, depth + 1, sub);
                    ulEl.appendChild(sub);
                }
            });
        }
        addChildren('__ROOT__', 1, ul);

        const tree = el('div', { class: 'joplin-tree' }, [ul]);
        root.appendChild(tree);
    }

    function treeItem(folder, depth, isAll) {
        const hasChildren = !isAll && ((state.childFolders[folder.id] || []).length > 0);
        const twisty = isAll ? '' : (hasChildren ? (state.expanded[folder.id] ? '▾' : '▸') : '·');
        const active = state.selectedFolder === folder.id;

        const item = el('li', {}, [
            el('div', {
                class: 'joplin-tree-item' + (active ? ' active' : ''),
                onclick: function (ev) {
                    if (ev.target.classList.contains('twisty') && hasChildren) {
                        state.expanded[folder.id] = !state.expanded[folder.id];
                    } else {
                        state.selectedFolder = folder.id;
                        state.selectedNote = null;
                        state.searchResults = null;
                        state.searchQuery = '';
                    }
                    render();
                }
            }, [
                el('span', { class: 'twisty', text: twisty }),
                el('span', { class: 'label', text: folder.title, title: folder.title }),
            ]),
        ]);
        return item;
    }

    function renderList(root) {
        root.innerHTML = '';

        const search = el('div', { class: 'joplin-search' }, [
            el('input', {
                type: 'search',
                placeholder: 'Search notes…',
                value: state.searchQuery,
                oninput: onSearchInput,
            }),
        ]);
        root.appendChild(search);

        const toolbar = el('div', { class: 'joplin-toolbar' }, [
            el('button', {
                class: 'primary',
                text: '+ New note',
                title: 'Create a new note in the selected notebook',
                onclick: function () { startCreateNote(); },
            }),
            el('button', {
                text: 'Reload',
                title: 'Rebuild the Joplin index',
                onclick: function () { reindex(); },
            }),
            el('span', {
                class: 'joplin-counts',
                text: Object.keys(state.notes).length + ' notes · ' +
                       Object.keys(state.folders).length + ' notebooks',
            }),
        ]);
        root.appendChild(toolbar);

        let items;
        if (state.searchResults !== null) {
            root.appendChild(el('div', { class: 'joplin-list-header',
                text: 'Search results (' + state.searchResults.length + ')' }));
            items = state.searchResults.map(function (r) {
                return {
                    id: r.id,
                    title: r.title,
                    mtime: r.mtime,
                    excerpt: r.excerpt,
                };
            });
        } else {
            const sel = state.selectedFolder;
            const listHeader = sel === '__ALL__'
                ? 'All notes'
                : ((state.folders[sel] || { title: 'Notes' }).title);
            root.appendChild(el('div', { class: 'joplin-list-header', text: listHeader }));

            if (sel === '__ALL__') {
                items = Object.values(state.notes);
            } else {
                items = state.notesInFolder[sel] || [];
            }
            items = items.slice().sort(function (a, b) {
                return (b.mtime || 0) - (a.mtime || 0);
            });
        }

        const ul = el('ul', { class: 'joplin-list' });
        if (items.length === 0) {
            ul.appendChild(el('li', { class: 'joplin-empty-list',
                text: state.searchResults !== null ? 'No notes match your search.' : 'No notes in this notebook.' }));
        } else {
            items.forEach(function (n) {
                const active = state.selectedNote === n.id;
                ul.appendChild(el('li', {
                    class: active ? 'active' : '',
                    onclick: function () { selectNote(n.id); },
                }, [
                    el('div', { class: 'title', text: n.title || '(untitled)' }),
                    el('div', { class: 'meta', text: relativeDate(n.mtime),
                                title: formatDate(n.mtime) }),
                    n.excerpt ? el('div', { class: 'excerpt', text: n.excerpt }) : null,
                ]));
            });
        }
        root.appendChild(ul);
    }

    function renderViewer(root) {
        root.innerHTML = '';

        // Editor takes precedence over the viewer
        if (state.editing && state.editingDraft) {
            renderEditor(root);
            return;
        }

        if (!state.selectedNote) {
            root.appendChild(el('div', { class: 'joplin-empty' }, [
                el('div', { class: 'joplin-empty-icon', text: '📝' }),
                el('div', { class: 'joplin-empty-title', text: 'No note selected' }),
                el('div', { class: 'joplin-empty-subtitle',
                    text: 'Choose a note from the list, or create a brand-new one.' }),
                el('button', {
                    class: 'joplin-empty-cta',
                    text: '+ New note',
                    onclick: function () { startCreateNote(); },
                }),
            ]));
            return;
        }
        const note = state.loadedNote;
        if (!note || note.id !== state.selectedNote) {
            root.appendChild(el('div', { class: 'joplin-loading', text: 'Loading note…' }));
            return;
        }

        // Header with title + Edit / Delete buttons
        const header = el('div', { class: 'joplin-viewer-header' }, [
            el('h1', { class: 'joplin-viewer-title', text: note.title || '(untitled)' }),
            el('div', { class: 'joplin-viewer-actions' }, [
                el('button', {
                    class: 'joplin-edit-btn',
                    text: '✎ Edit',
                    title: 'Edit this note',
                    onclick: function () { startEditNote(note); },
                }),
                el('button', {
                    class: 'joplin-delete-btn',
                    text: '🗑 Delete',
                    title: 'Move this note to the Joplin trash',
                    onclick: function () { confirmDeleteNote(note); },
                }),
            ]),
        ]);
        root.appendChild(header);

        root.appendChild(el('div', {
            class: 'joplin-viewer-meta',
            text: 'Updated ' + relativeDate(note.updated_time || note.mtime) +
                  (note.created_time ? ' · Created ' + relativeDate(note.created_time) : ''),
            title: 'Updated ' + formatDate(note.updated_time || note.mtime),
        }));
        const body = el('div', { class: 'joplin-viewer-body' });
        body.innerHTML = renderMarkdown(note.body || '');
        root.appendChild(body);
    }

    function renderEditor(root) {
        const draft = state.editingDraft;
        const isNew = draft.isNew;

        // Resolve parent notebook label for display
        const parentLabel = draft.parent_id && state.folders[draft.parent_id]
            ? state.folders[draft.parent_id].title
            : 'root';

        // Notes-style: a single textarea where the first markdown heading
        // line *is* the title. The user edits the title by editing line 1.
        const editor = el('textarea', {
            class: 'joplin-editor-body',
            placeholder: '# Title goes here\n\nWrite your note in Markdown…',
            spellcheck: 'true',
            oninput: function (ev) { state.editingDraft.content = ev.target.value; },
            onkeydown: function (ev) {
                // Ctrl/Cmd+S to save
                if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
                    ev.preventDefault();
                    const status = root.querySelector('.joplin-editor-status');
                    saveDraft(status);
                }
                // Esc to cancel
                if (ev.key === 'Escape' && !state.saving) {
                    cancelEdit();
                }
            },
        });
        editor.value = draft.content || '';

        const status = el('div', { class: 'joplin-editor-status' });

        const saveBtn = el('button', {
            class: 'primary',
            text: state.saving ? 'Saving…' : 'Save',
            disabled: state.saving ? 'disabled' : null,
            onclick: function () { saveDraft(status); },
        });

        const cancelBtn = el('button', {
            text: 'Cancel',
            disabled: state.saving ? 'disabled' : null,
            onclick: function () { cancelEdit(); },
        });

        root.appendChild(el('div', { class: 'joplin-editor-header' }, [
            el('div', { class: 'joplin-editor-mode' }, [
                document.createTextNode(isNew ? 'New note in: ' : 'Editing note in: '),
                el('strong', { text: parentLabel }),
            ]),
            el('div', { class: 'joplin-editor-actions' }, [saveBtn, cancelBtn]),
        ]));

        root.appendChild(el('div', {
            class: 'joplin-editor-hint',
            text: 'Tip: the first “# Heading” line becomes the note title. Press Ctrl+S to save, Esc to cancel.',
        }));

        root.appendChild(editor);
        root.appendChild(status);

        // Auto-focus and place cursor in a sensible spot
        setTimeout(function () {
            editor.focus();
            if (isNew) {
                // Highlight the placeholder title so typing replaces it
                const start = '# '.length;
                const end = (draft.content || '').indexOf('\n');
                if (end > start) editor.setSelectionRange(start, end);
            } else {
                // Place cursor at end of content for editing
                editor.setSelectionRange(editor.value.length, editor.value.length);
            }
        }, 0);
    }

    // ---------- Markdown editing helpers (toolbar actions) ----------------

    /** Re-fire input so state.editingDraft.content stays in sync. */
    function syncEditor(ta) {
        state.editingDraft.content = ta.value;
    }

    /** Wrap the current selection with `before`/`after`. If empty, insert placeholder. */
    function applyMdInline(ta, before, after, placeholder) {
        const start = ta.selectionStart;
        const end   = ta.selectionEnd;
        const sel   = ta.value.slice(start, end) || placeholder;
        const next  = ta.value.slice(0, start) + before + sel + after + ta.value.slice(end);
        ta.value = next;
        const cursorStart = start + before.length;
        ta.setSelectionRange(cursorStart, cursorStart + sel.length);
        syncEditor(ta);
    }

    /** Toggle a line prefix (e.g. "# ", "- ", "> ") on every line in the selection. */
    function applyMdLinePrefix(ta, prefix) {
        const value = ta.value;
        let start = ta.selectionStart;
        let end   = ta.selectionEnd;
        // Expand selection to whole lines
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const lineEnd   = value.indexOf('\n', end);
        const sliceEnd  = lineEnd === -1 ? value.length : lineEnd;
        const block     = value.slice(lineStart, sliceEnd);
        // If every non-blank line already starts with this prefix, strip it (toggle).
        const lines = block.split('\n');
        const allHave = lines.every(function (l) { return l === '' || l.startsWith(prefix); });
        const newBlock = lines.map(function (l) {
            if (l === '') return l;
            if (allHave) return l.slice(prefix.length);
            // Strip any other heading prefix when applying a heading
            const stripped = /^#{1,6}\s+/.test(l) && /^#{1,6}\s/.test(prefix) ? l.replace(/^#{1,6}\s+/, '') : l;
            return prefix + stripped;
        }).join('\n');
        ta.value = value.slice(0, lineStart) + newBlock + value.slice(sliceEnd);
        const delta = newBlock.length - block.length;
        ta.setSelectionRange(lineStart, lineStart + newBlock.length);
        syncEditor(ta);
        void delta;
    }

    /** Numbered list: prefix each selected line with "1. ", "2. ", … */
    function applyMdNumberedList(ta) {
        const value = ta.value;
        const start = ta.selectionStart;
        const end   = ta.selectionEnd;
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const lineEnd   = value.indexOf('\n', end);
        const sliceEnd  = lineEnd === -1 ? value.length : lineEnd;
        const lines     = value.slice(lineStart, sliceEnd).split('\n');
        let n = 1;
        const newBlock = lines.map(function (l) {
            if (l.trim() === '') return l;
            return (n++) + '. ' + l.replace(/^\d+\.\s+/, '');
        }).join('\n');
        ta.value = value.slice(0, lineStart) + newBlock + value.slice(sliceEnd);
        ta.setSelectionRange(lineStart, lineStart + newBlock.length);
        syncEditor(ta);
    }

    /** Insert/wrap as `[text](url)`. Prompts for URL if selection is plain text. */
    function applyMdLink(ta) {
        const start = ta.selectionStart;
        const end   = ta.selectionEnd;
        const sel   = ta.value.slice(start, end);
        const url   = window.prompt('Link URL:', 'https://');
        if (url === null) return;
        const text  = sel || 'link text';
        const insert = '[' + text + '](' + url + ')';
        ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
        const cursorStart = start + 1;
        ta.setSelectionRange(cursorStart, cursorStart + text.length);
        syncEditor(ta);
    }

    /** Wrap selection in a fenced ```code``` block. */
    function applyMdCodeBlock(ta) {
        const start = ta.selectionStart;
        const end   = ta.selectionEnd;
        const sel   = ta.value.slice(start, end) || 'code here';
        const before = (start > 0 && ta.value[start - 1] !== '\n') ? '\n' : '';
        const after  = (end < ta.value.length && ta.value[end] !== '\n') ? '\n' : '';
        const insert = before + '```\n' + sel + '\n```' + after;
        ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
        const cursorStart = start + before.length + 4;
        ta.setSelectionRange(cursorStart, cursorStart + sel.length);
        syncEditor(ta);
    }

    /** Insert a horizontal rule on its own line. */
    function applyMdHr(ta) {
        const start = ta.selectionStart;
        const before = (start > 0 && ta.value[start - 1] !== '\n') ? '\n' : '';
        const insert = before + '\n---\n\n';
        ta.value = ta.value.slice(0, start) + insert + ta.value.slice(start);
        const pos = start + insert.length;
        ta.setSelectionRange(pos, pos);
        syncEditor(ta);
    }

    /**
     * Notes-style title extraction: if the first non-empty line begins with
     * one or more `#` markers, that's the title (markers stripped). Everything
     * after that line (skipping a single blank separator) is the body.
     *
     * Returns { title, body }.
     */
    function splitTitleAndBody(content) {
        const text = String(content || '').replace(/\r\n?/g, '\n');
        const lines = text.split('\n');
        let i = 0;
        // Skip leading blank lines
        while (i < lines.length && lines[i].trim() === '') i++;
        if (i >= lines.length) {
            return { title: '', body: '' };
        }

        let title;
        const firstLine = lines[i];
        const m = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(firstLine);
        if (m) {
            title = m[2].trim();
        } else {
            // Fallback: first non-empty line is the title
            title = firstLine.trim();
        }

        // Body = everything after the title line, with one blank separator skipped.
        let bodyStart = i + 1;
        if (bodyStart < lines.length && lines[bodyStart].trim() === '') {
            bodyStart++;
        }
        const body = lines.slice(bodyStart).join('\n').replace(/\s+$/, '');
        return { title: title, body: body };
    }

    // ---------- Actions ----------------------------------------------------

    /**
     * POST/PUT helper that sends a form-urlencoded body and returns parsed JSON.
     * Used for the create/update note endpoints.
     */
    function apiSend(url, method, params) {
        const body = Object.keys(params)
            .map(function (k) {
                return encodeURIComponent(k) + '=' + encodeURIComponent(params[k] == null ? '' : params[k]);
            })
            .join('&');
        return fetchJson(url, {
            method: method,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body,
        });
    }

    function startCreateNote() {
        // Pick a sensible default parent: the currently-selected notebook,
        // or root if "All notes" is active.
        const sel = state.selectedFolder;
        const parentId = (sel && sel !== '__ALL__' && state.folders[sel]) ? sel : null;

        state.editing = true;
        state.previewMode = false;
        state.editingDraft = {
            id: null,
            isNew: true,
            parent_id: parentId,
            content: '# New note\n\n',
        };
        state.selectedNote = null;
        state.loadedNote   = null;
        render();
    }

    function startEditNote(note) {
        state.editing = true;
        state.previewMode = false;
        const title = (note.title || 'Untitled').trim();
        const body  = note.body || '';
        state.editingDraft = {
            id: note.id,
            isNew: false,
            parent_id: note.parent_id || null,
            content: '# ' + title + '\n\n' + body,
        };
        render();
    }

    function cancelEdit() {
        if (state.saving) return;
        state.editing = false;
        state.previewMode = false;
        state.editingDraft = null;
        render();
    }

    /**
     * Confirm + delete a note. The backend moves the file into
     * `.joplin-trash/` so Joplin's sync stops seeing it (deletion
     * propagates to all clients) but the bytes are preserved on disk.
     */
    function confirmDeleteNote(note) {
        if (state.saving || state.deleting) return;
        const title = (note && note.title) ? note.title : '(untitled)';
        if (!window.confirm(
            'Delete "' + title + '"?\n\n' +
            'The note will be moved into the Joplin trash folder. ' +
            'It will disappear from every Joplin client on the next sync.'
        )) {
            return;
        }
        deleteNote(note.id);
    }

    function deleteNote(id) {
        if (!id || state.deleting) return;
        state.deleting = true;
        render();

        apiSend(apiUrl('/api/note/' + encodeURIComponent(id)), 'DELETE', {})
            .then(function () {
                state.deleting = false;
                // Drop local references so the viewer goes back to the empty state.
                if (state.selectedNote === id) {
                    state.selectedNote = null;
                    state.loadedNote   = null;
                }
                if (state.notes && state.notes[id]) {
                    delete state.notes[id];
                }
                showInfo('Note deleted');
                return loadTree().then(function () { render(); });
            })
            .catch(function (err) {
                state.deleting = false;
                const msg = (err.body && err.body.message) || err.message || 'Delete failed';
                showError(msg);
                render();
            });
    }

    function saveDraft(statusEl) {
        if (state.saving || !state.editingDraft) return;

        const d = state.editingDraft;
        const split = splitTitleAndBody(d.content || '');
        const title = split.title;
        const body  = split.body;

        if (title === '' && body.trim() === '') {
            statusEl.textContent = 'Please enter a title or body.';
            statusEl.className = 'joplin-editor-status error';
            return;
        }

        state.saving = true;
        statusEl.textContent = 'Saving…';
        statusEl.className = 'joplin-editor-status';
        render();

        let promise;
        if (d.isNew) {
            promise = apiSend(apiUrl('/api/note'), 'POST', {
                title: title || 'Untitled',
                body: body,
                parent_id: d.parent_id || '',
            });
        } else {
            promise = apiSend(apiUrl('/api/note/' + encodeURIComponent(d.id)), 'PUT', {
                title: title || 'Untitled',
                body: body,
            });
        }

        promise.then(function (resp) {
            state.saving = false;
            state.editing = false;
            state.editingDraft = null;

            // Reload the index so the note appears / is re-sorted, then select it.
            return loadTree().then(function () {
                if (resp && resp.id) {
                    selectNote(resp.id);
                } else {
                    render();
                }
            });
        }).catch(function (err) {
            state.saving = false;
            const msg = (err.body && err.body.message) || err.message || 'Save failed';
            const root = document.getElementById('joplin-app');
            const liveStatus = root && root.querySelector('.joplin-editor-status');
            if (liveStatus) {
                liveStatus.textContent = msg;
                liveStatus.className = 'joplin-editor-status error';
            } else {
                showError(msg);
            }
            render();
        });
    }

    let searchTimer = null;
    function onSearchInput(ev) {
        state.searchQuery = ev.target.value;
        if (searchTimer) clearTimeout(searchTimer);
        if (!state.searchQuery || state.searchQuery.trim().length < 2) {
            state.searchResults = null;
            render();
            return;
        }
        searchTimer = setTimeout(doSearch, 250);
    }

    function doSearch() {
        const q = state.searchQuery.trim();
        if (q.length < 2) return;
        fetchJson(apiUrl('/api/search?q=' + encodeURIComponent(q)))
            .then(function (resp) {
                if (resp.query !== state.searchQuery.trim()) return; // stale
                state.searchResults = resp.results || [];
                render();
            })
            .catch(function (err) { showError('Search failed: ' + err.message); });
    }

    function selectNote(id) {
        state.selectedNote = id;
        state.loadedNote = null;
        render();
        fetchJson(apiUrl('/api/note/' + encodeURIComponent(id)))
            .then(function (note) {
                if (state.selectedNote !== id) return; // user moved on
                state.loadedNote = note;
                render();
            })
            .catch(function (err) {
                state.loadedNote = null;
                showError('Could not load note: ' + err.message);
            });
    }

    function reindex() {
        // Optimistically clear any stale cached state so the UI shows progress.
        const prevSelected = state.selectedNote;
        state.loadedNote = null;
        renderList(app.list);
        return fetchJson(apiUrl('/api/reindex'), { method: 'POST' })
            .then(function (resp) {
                if (window.console && console.info) {
                    console.info('[Joplin] reindex complete', resp);
                }
                return loadTree();
            })
            .then(function () {
                // If the previously-selected note still exists, re-select it.
                if (prevSelected && state.notes[prevSelected]) {
                    selectNote(prevSelected);
                } else {
                    state.selectedNote = null;
                    state.loadedNote = null;
                    render();
                }
            })
            .catch(function (err) { showError('Reindex failed: ' + err.message); });
    }

    function loadTree() {
        return fetchJson(apiUrl('/api/tree'))
            .then(function (resp) {
                if (window.console && console.info) {
                    console.info('[Joplin] tree loaded',
                        '— notes:', (resp.notes || []).length,
                        'folders:', (resp.folders || []).length,
                        'built_at:', resp.built_at);
                }
                if (!resp.found) {
                    renderNotFound(resp);
                    return;
                }
                groupIndex(resp.folders || [], resp.notes || []);
                render();
            });
    }

    // ---------- Layout / errors -------------------------------------------

    const app = { root: null, tree: null, list: null, viewer: null };

    function buildLayout() {
        const root = document.getElementById('joplin-app');
        root.innerHTML = '';
        app.root = root;
        app.tree   = el('div', { class: 'joplin-pane joplin-pane-tree' });
        app.list   = el('div', { class: 'joplin-pane joplin-pane-list' });
        app.viewer = el('div', { class: 'joplin-pane joplin-pane-viewer' });
        root.appendChild(app.tree);
        root.appendChild(app.list);
        root.appendChild(app.viewer);
    }

    function render() {
        if (!app.root) return;
        renderTree(app.tree);
        renderList(app.list);
        renderViewer(app.viewer);
    }

    function renderNotFound(resp) {
        const root = document.getElementById('joplin-app');
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'joplin-empty' }, [
            el('h2', { text: 'No Joplin sync folder found' }),
            el('p', { text:
                'This app looks for a folder containing Joplin\'s "info.json" ' +
                'marker (up to three levels deep under your home folder).' }),
            el('p', { text:
                'You can set the path explicitly below (relative to your files ' +
                'root, e.g. "Joplin" or "Notes/Joplin"):' }),
            (function () {
                const input = el('input', {
                    type: 'text',
                    placeholder: 'Joplin',
                    value: resp.configured || '',
                    style: 'width: 260px; padding: 4px 8px;',
                });
                const btn = el('button', {
                    text: 'Save & retry',
                    onclick: function () {
                        fetchJson(apiUrl('/api/root'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: 'path=' + encodeURIComponent(input.value),
                        })
                        .then(function () { return reindex(); })
                        .then(function () {
                            buildLayout();
                            return loadTree();
                        })
                        .catch(function (err) { showError(err.message); });
                    },
                });
                return el('div', { style: 'margin-top: 12px;' }, [input, el('span', { text: ' ' }), btn]);
            })(),
        ]));
    }

    function showError(msg) {
        const root = document.getElementById('joplin-app');
        const existing = root.querySelector('.joplin-error');
        if (existing) existing.remove();
        root.appendChild(el('div', { class: 'joplin-error', text: msg }));
    }

    function showInfo(msg) {
        const root = document.getElementById('joplin-app');
        const existing = root.querySelector('.joplin-toast');
        if (existing) existing.remove();
        const toast = el('div', { class: 'joplin-toast', text: msg });
        root.appendChild(toast);
        setTimeout(function () { if (toast.parentNode) toast.remove(); }, 2500);
    }

    // ---------- Boot --------------------------------------------------------

    function boot() {
        buildLayout();
        loadTree().catch(function (err) {
            showError('Failed to load Joplin index: ' + err.message);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
