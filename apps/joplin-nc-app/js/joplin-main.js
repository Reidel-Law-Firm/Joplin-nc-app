/*!
 * Joplin — Nextcloud app (frontend SPA, vanilla JS, no build step)
 *
 *  - Fetches the notebook/notes index from /apps/joplin-nc-app/api/tree
 *  - Loads single notes from /apps/joplin-nc-app/api/note/{id}
 *  - Full-text search via /apps/joplin-nc-app/api/search?q=...
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

    /* Inline 16x16 SVG icons (Material-style) used by icon-only action buttons. */
    const ICONS = {
        pencil: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
        trash:  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
    };

    function escHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Re-allow a small whitelist of safe HTML tags after escHtml() has run.
     * Joplin notes commonly contain raw <br>, <b>, <i>, <u>, <sub>, <sup>, etc.
     * This converts the escaped &lt;tag&gt; sequences back into real tags so
     * they render, while every other tag remains harmlessly escaped.
     */
    function unescapeSafeTags(s) {
        // Tags with no attributes that we trust enough to render.
        const TAGS = ['br', 'b', 'strong', 'i', 'em', 'u', 'sub', 'sup', 'mark', 's', 'del', 'ins', 'kbd', 'small'];
        const re = new RegExp('&lt;(/?)(' + TAGS.join('|') + ')\\s*/?&gt;', 'gi');
        return s.replace(re, function (_m, slash, tag) {
            const t = tag.toLowerCase();
            if (t === 'br' || t === 'hr') return '<' + t + '>';
            return '<' + slash + t + '>';
        });
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
            return OC.generateUrl('/apps/joplin-nc-app' + path);
        }
        return '/apps/joplin-nc-app' + path;
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

    // ---------- Markdown renderer (marked + DOMPurify) ---------------------
    // Uses the vendored `marked` parser and sanitizes the output with
    // DOMPurify to prevent XSS. Falls back to a minimal built-in renderer
    // if either library failed to load.

    let _markedConfigured = false;
    function configureMarked() {
        if (_markedConfigured || !window.marked) return;
        try {
            window.marked.setOptions({
                gfm: true,           // GitHub-flavoured Markdown (tables, strikethrough, autolinks)
                breaks: true,        // newline -> <br> (Joplin behaviour)
                headerIds: false,    // no auto id="..." on headings
                mangle: false,       // don't obfuscate autolink emails
                smartypants: false,
            });
            // Open all links in a new tab with safe rel attributes.
            const renderer = new window.marked.Renderer();
            const origLink = renderer.link.bind(renderer);
            renderer.link = function (href, title, text) {
                const html = origLink(href, title, text);
                return html.replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ');
            };
            window.marked.use({ renderer: renderer });
        } catch (_e) { /* older API – ignore */ }
        _markedConfigured = true;
    }

    function sanitizeHtml(html) {
        if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
            return window.DOMPurify.sanitize(html, {
                USE_PROFILES: { html: true },
                ADD_ATTR: ['target', 'rel'],
                FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'object', 'embed', 'script'],
                FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus'],
            });
        }
        return html; // very last-resort fallback
    }

    function renderMarkdown(md) {
        if (!md) return '';
        md = String(md).replace(/\r\n?/g, '\n');

        // Preferred path: marked + DOMPurify (loaded as vendor scripts).
        if (window.marked) {
            configureMarked();
            try {
                const parser = (typeof window.marked.parse === 'function')
                    ? window.marked.parse
                    : window.marked;
                const raw = parser(md);
                return sanitizeHtml(raw);
            } catch (e) {
                // Fall through to legacy renderer below on parser error.
                console.warn('Joplin: marked failed, falling back to built-in renderer', e);
            }
        }

        return renderMarkdownLegacy(md);
    }

    // Built-in fallback renderer (kept for resilience if vendor libs fail).
    function renderMarkdownLegacy(md) {
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
            // Re-allow a small whitelist of inline HTML tags (e.g. <br>, <b>, <sup>)
            s = unescapeSafeTags(s);
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
                out.push('<blockquote>' + renderMarkdownLegacy(buf.join('\n')) + '</blockquote>');
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
        sidebarOpen: false,  // mobile slide-in sidebar
        notebooksCollapsed: false, // collapsible notebooks section in sidebar
        loading: false,      // global loading overlay (initial fetch / reindex)
        syncStatus: 'idle',        // 'idle' | 'syncing' | 'ok' | 'error'
        syncStatusMessage: '',     // tooltip text for the sync pill
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

        const children = [
            el('span', { class: 'twisty', text: twisty }),
            el('span', { class: 'label', text: folder.title, title: folder.title }),
        ];

        // Inline actions for real notebooks (not for the synthetic "All notes").
        if (!isAll) {
            children.push(el('span', { class: 'joplin-tree-actions' }, [
                el('button', {
                    class: 'joplin-tree-action joplin-icon-only',
                    type: 'button',
                    title: 'Rename notebook',
                    'aria-label': 'Rename notebook',
                    html: ICONS.pencil,
                    onclick: function (ev) {
                        ev.stopPropagation();
                        promptRenameFolder(folder);
                    },
                }),
                el('button', {
                    class: 'joplin-tree-action joplin-icon-only danger',
                    type: 'button',
                    title: 'Delete notebook',
                    'aria-label': 'Delete notebook',
                    html: ICONS.trash,
                    onclick: function (ev) {
                        ev.stopPropagation();
                        confirmDeleteFolder(folder);
                    },
                }),
            ]));
        }

        const item = el('li', {}, [
            el('div', {
                class: 'joplin-tree-item' + (active ? ' active' : ''),
                onclick: function (ev) {
                    // Ignore clicks that originated inside the inline actions.
                    if (ev.target.closest && ev.target.closest('.joplin-tree-actions')) return;
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
            }, children),
        ]);
        return item;
    }

    function renderNotebooksPane(root) {
        root.innerHTML = '';

        // Brand header (app title + total notes count + sync status)
        const statusLabel = ({
            syncing: 'Syncing…',
            ok:      'Synced',
            error:   'Failed',
        })[state.syncStatus] || '';
        const statusPill = statusLabel
            ? el('span', {
                class: 'joplin-sync-pill ' + state.syncStatus,
                text: statusLabel,
                title: state.syncStatusMessage || statusLabel,
            })
            : null;

        const header = el('div', { class: 'joplin-sidebar-header' }, [
            el('div', { class: 'joplin-sidebar-brand' }, [
                el('span', { class: 'joplin-sidebar-title', text: 'Joplin' }),
                el('span', { class: 'joplin-sidebar-counts',
                    text: Object.keys(state.notes).length + ' notes' }),
                statusPill,
            ].filter(Boolean)),
        ]);
        root.appendChild(header);

        // Notebooks section (always visible in its own pane)
        const notebooks = el('div', { class: 'joplin-notebooks' });
        const notebooksHeader = el('div', {
            class: 'joplin-notebooks-header',
        }, [
            el('span', { class: 'joplin-notebooks-label', text: 'Notebooks' }),
            el('span', { class: 'joplin-notebooks-count',
                text: String(Object.keys(state.folders).length) }),
            el('span', {
                class: 'joplin-icon-btn',
                role: 'button',
                tabindex: '0',
                title: 'Create notebook',
                'aria-label': 'Create notebook',
                text: '+ New',
                onclick: function (ev) { ev.stopPropagation(); promptCreateFolder(); },
            }),
            el('span', {
                class: 'joplin-icon-btn',
                role: 'button',
                tabindex: '0',
                title: 'Reload index',
                'aria-label': 'Reload index',
                text: 'Reload',
                onclick: function (ev) { ev.stopPropagation(); reindex(); },
            }),
        ]);
        notebooks.appendChild(notebooksHeader);

        const treeWrap = el('div', { class: 'joplin-notebooks-body' });
        renderTree(treeWrap);
        notebooks.appendChild(treeWrap);

        root.appendChild(notebooks);
    }

    function renderNotesPane(root) {
        root.innerHTML = '';

        // Header: selected notebook title (or search heading) + New note button
        let listHeaderText;
        let items;
        if (state.searchResults !== null) {
            listHeaderText = 'Search results';
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
            listHeaderText = sel === '__ALL__'
                ? 'All notes'
                : ((state.folders[sel] || { title: 'Notes' }).title);

            if (sel === '__ALL__') {
                items = Object.values(state.notes);
            } else {
                items = state.notesInFolder[sel] || [];
            }
            items = items.slice().sort(function (a, b) {
                return (b.mtime || 0) - (a.mtime || 0);
            });
        }

        const paneHeader = el('div', { class: 'joplin-notes-pane-header' }, [
            el('div', { class: 'joplin-notes-pane-title', text: listHeaderText, title: listHeaderText }, [
                el('span', { class: 'joplin-notes-pane-count', text: ' (' + items.length + ')' }),
            ]),
            el('button', {
                class: 'joplin-new-btn',
                title: 'Create a new note',
                'aria-label': 'Create a new note',
                onclick: function () { startCreateNote(); state.sidebarOpen = false; },
            }, [el('span', { text: '+ New note' })]),
        ]);
        root.appendChild(paneHeader);

        const search = el('div', { class: 'joplin-search' }, [
            el('input', {
                type: 'search',
                placeholder: 'Search notes…',
                value: state.searchQuery,
                oninput: onSearchInput,
            }),
        ]);
        root.appendChild(search);

        const ul = el('ul', { class: 'joplin-list' });
        if (items.length === 0) {
            const isSearch = state.searchResults !== null;
            const emptyLi = el('li', { class: 'joplin-empty-list' }, [
                el('div', { class: 'joplin-empty-list-icon',
                    text: isSearch ? '🔍' : '📝' }),
                el('div', { class: 'joplin-empty-list-title',
                    text: isSearch ? 'No matching notes' : 'No notes yet' }),
                el('div', { class: 'joplin-empty-list-msg',
                    text: isSearch
                        ? 'Try a different search term.'
                        : 'Create your first note to get started.' }),
                isSearch ? null : el('button', {
                    class: 'joplin-empty-list-cta',
                    text: '+ Create New Note',
                    onclick: function () { startCreateNote(); },
                }),
            ]);
            ul.appendChild(emptyLi);
        } else {
            items.forEach(function (n) {
                const active = state.selectedNote === n.id;
                const title = cleanTitle(n.title) || '(untitled)';
                const preview = n.excerpt || firstLineOfBody(n);
                ul.appendChild(el('li', {
                    class: active ? 'active' : '',
                    title: title,
                    onclick: function () { selectNote(n.id); state.sidebarOpen = false; },
                }, [
                    el('div', { class: 'title', text: title, title: title }),
                    preview ? el('div', { class: 'excerpt', text: preview }) : null,
                    el('div', { class: 'meta', text: relativeDate(n.mtime),
                                title: formatDate(n.mtime) }),
                ]));
            });
        }
        root.appendChild(ul);
    }

    /**
     * Strip Markdown emphasis/strikethrough/heading/code markers from a title for
     * display only. The underlying note content is unchanged so Joplin sync still
     * sees the original Markdown. Examples:
     *   "***~~Hello~~***" -> "Hello"
     *   "# My note"       -> "My note"
     *   "**Bold**"        -> "Bold"
     */
    function cleanTitle(s) {
        if (!s) return '';
        let t = String(s).trim();
        // Strip leading ATX heading marks (# ## ### ...)
        t = t.replace(/^#{1,6}\s+/, '');
        // Strip surrounding bold/italic/strike markers repeatedly
        // Order: longest markers first (***, ___, **, __, ~~, *, _, `)
        const markers = ['***', '___', '**', '__', '~~', '*', '_', '`'];
        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < markers.length; i++) {
                const m = markers[i];
                if (t.length > m.length * 2 && t.startsWith(m) && t.endsWith(m)) {
                    t = t.slice(m.length, -m.length).trim();
                    changed = true;
                    break;
                }
            }
        }
        return t || s;
    }

    /** Best-effort short preview from index data (title is excluded if it duplicates). */
    function firstLineOfBody(n) {
        const src = n.body_preview || n.preview || '';
        if (!src) return '';
        const line = String(src).split('\n').map(function (s) { return s.trim(); })
            .filter(function (s) { return s && !/^#/.test(s); })[0];
        return line || '';
    }

    function renderViewer(root) {
        root.innerHTML = '';

        // Mobile sidebar toggle (shows only on small screens via CSS)
        const menuBtn = el('button', {
            class: 'joplin-menu-btn',
            'aria-label': 'Show notes list',
            title: 'Show notes list',
            onclick: function () { state.sidebarOpen = !state.sidebarOpen; render(); },
            text: 'Notes',
        });
        root.appendChild(menuBtn);

        // Editor takes precedence over the viewer
        if (state.editing && state.editingDraft) {
            renderEditor(root);
            return;
        }

        if (!state.selectedNote) {
            const totalNotes = Object.keys(state.notes).length;
            root.appendChild(el('div', { class: 'joplin-empty' }, [
                el('div', { class: 'joplin-empty-icon', text: '📝' }),
                el('div', { class: 'joplin-empty-title',
                    text: totalNotes === 0 ? 'No notes yet' : 'No note selected' }),
                el('div', { class: 'joplin-empty-subtitle',
                    text: totalNotes === 0
                        ? 'Create your first note and it will sync with all your Joplin clients.'
                        : 'Choose a note from the list, or create a brand-new one.' }),
                el('button', {
                    class: 'joplin-empty-cta',
                    text: '+ Create New Note',
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

        // Header with title + Edit / Open-in-Text / Delete buttons
        const headerActions = [
            el('button', {
                class: 'joplin-edit-btn joplin-icon-only',
                title: 'Edit this note',
                'aria-label': 'Edit this note',
                html: ICONS.pencil,
                onclick: function () { startEditNote(note); },
            }),
        ];
        // Deep-link to Nextcloud's built-in Text app via Files (.md handler).
        // if (note.file_id && window.OC && typeof OC.generateUrl === 'function') {
        //     headerActions.push(el('a', {
        //         class: 'joplin-text-btn',
        //         href: OC.generateUrl('/f/' + encodeURIComponent(note.file_id)),
        //         target: '_blank',
        //         rel: 'noopener',
        //         title: 'Open this note in the Nextcloud Text editor',
        //         'aria-label': 'Open in Nextcloud Text',
        //         text: 'Open in Text',
        //     }));
        // }
        headerActions.push(el('button', {
            class: 'joplin-delete-btn joplin-icon-only',
            title: 'Move this note to the Joplin trash',
            'aria-label': 'Delete this note',
            html: ICONS.trash,
            onclick: function () { confirmDeleteNote(note); },
        }));

        const header = el('div', { class: 'joplin-viewer-header' }, [
            el('h1', { class: 'joplin-viewer-title', text: cleanTitle(note.title) || '(untitled)' }),
            el('div', { class: 'joplin-viewer-actions' }, headerActions),
        ]);
        root.appendChild(header);

        root.appendChild(el('div', {
            class: 'joplin-viewer-meta',
            text: 'Updated ' + relativeDate(note.updated_time || note.mtime) +
                  (note.created_time ? ' · Created ' + relativeDate(note.created_time) : ''),
            title: 'Updated ' + formatDate(note.updated_time || note.mtime),
        }));
        const body = el('div', { class: 'joplin-viewer-body' });
        // Strip a leading "# Title" heading if it duplicates the metadata title,
        // so the title doesn't appear twice in the viewer.
        body.innerHTML = renderMarkdown(stripDuplicateTitle(note.body || '', note.title || ''));
        root.appendChild(body);
    }

    /**
     * If the note body's first non-empty line is a Markdown heading whose text
     * equals the note's metadata title, drop that heading (and a single blank
     * separator line) so the viewer doesn't display the title twice.
     */
    function stripDuplicateTitle(body, title) {
        if (!body) return '';
        const t = String(title || '').trim().toLowerCase();
        if (!t) return body;
        const lines = String(body).replace(/\r\n?/g, '\n').split('\n');
        let i = 0;
        while (i < lines.length && lines[i].trim() === '') i++;
        if (i >= lines.length) return body;
        const m = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
        if (!m) return body;
        if (m[2].trim().toLowerCase() !== t) return body;
        // Remove the heading line + a single blank separator if present
        lines.splice(i, 1);
        if (i < lines.length && lines[i].trim() === '') {
            lines.splice(i, 1);
        }
        return lines.join('\n');
    }

    function renderEditor(root) {
        const draft = state.editingDraft;
        const isNew = draft.isNew;

        // Resolve parent notebook label for display
        const parentLabel = draft.parent_id && state.folders[draft.parent_id]
            ? state.folders[draft.parent_id].title
            : 'root';

        const status = el('div', { class: 'joplin-editor-status' });

        const saveBtn = el('button', {
            class: 'primary',
            text: state.saving ? 'Saving…' : 'Save',
            disabled: state.saving ? 'disabled' : null,
            onclick: function () {
                // Pull the latest content out of whichever editor surface
                // is currently mounted (Toast UI or fallback textarea).
                if (state.mdEditor && typeof state.mdEditor.getMarkdown === 'function') {
                    state.editingDraft.content = state.mdEditor.getMarkdown();
                }
                saveDraft(status);
            },
        });

        const cancelBtn = el('button', {
            text: 'Cancel',
            disabled: state.saving ? 'disabled' : null,
            onclick: function () { cancelEdit(); },
        });

        // Compact header bar (title-row + actions, single line).
        root.appendChild(el('div', { class: 'joplin-editor-header' }, [
            el('div', { class: 'joplin-editor-mode' }, [
                el('span', { class: 'joplin-editor-mode-icon', text: isNew ? '✎' : '✏' }),
                document.createTextNode(isNew ? ' New note in ' : ' Editing in '),
                el('strong', { text: parentLabel }),
            ]),
            el('div', { class: 'joplin-editor-actions' }, [cancelBtn, saveBtn]),
        ]));

        // Editor host — Toast UI mounts here directly if available; otherwise
        // a plain <textarea> fallback is appended so the user can always edit.
        const host = el('div', { class: 'joplin-rte-host' });
        root.appendChild(host);
        root.appendChild(status);

        if (window.toastui && window.toastui.Editor) {
            try {
                mountToastEditor(host, draft, isNew, status);
                return;
            } catch (e) {
                console.warn('Joplin: Toast UI Editor init failed, using plain textarea', e);
                host.innerHTML = '';
            }
        }

        // -------- Plain-textarea fallback --------
        const editor = el('textarea', {
            class: 'joplin-editor-body',
            placeholder: '# Title goes here\n\nWrite your note in Markdown…',
            spellcheck: 'true',
            oninput: function (ev) { state.editingDraft.content = ev.target.value; },
        });
        editor.value = draft.content || '';
        host.appendChild(editor);

        editor.addEventListener('keydown', function (ev) {
            if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
                ev.preventDefault();
                saveDraft(status);
            }
            if (ev.key === 'Escape' && !state.saving) {
                cancelEdit();
            }
        });
        setTimeout(function () {
            editor.focus();
            if (isNew) {
                const start = '# '.length;
                const end = (draft.content || '').indexOf('\n');
                if (end > start) editor.setSelectionRange(start, end);
            } else {
                editor.setSelectionRange(editor.value.length, editor.value.length);
            }
        }, 0);
    }

    /**
     * Mount Toast UI Editor directly into `host`. Markdown is the source of
     * truth (`editor.getMarkdown()`), so the existing Joplin save/sync
     * pipeline is byte-compatible.
     *
     * Toast UI gives us:
     *   - WYSIWYG mode by default (real rich-text editing surface)
     *   - A native “Markdown” tab for power users
     *   - Built-in toolbar: bold / italic / strike / heading / lists /
     *     quote / link / code / image / table
     */
    function mountToastEditor(host, draft, isNew, statusEl) {
        // Tear down any previous instance bound to a stale DOM node.
        teardownEditor();

        // Compact toolbar = better fit on narrow Nextcloud viewer panes.
        const isNarrow = window.innerWidth && window.innerWidth < 900;
        // Full toolbar — all formatting features Toast UI ships with.
        const toolbar = isNarrow
            ? [
                ['heading', 'bold', 'italic', 'strike'],
                ['hr', 'quote'],
                ['ul', 'ol', 'task', 'indent', 'outdent'],
                ['table', 'image', 'link'],
                ['code', 'codeblock'],
            ]
            : [
                ['heading', 'bold', 'italic', 'strike'],
                ['hr', 'quote'],
                ['ul', 'ol', 'task', 'indent', 'outdent'],
                ['table', 'image', 'link'],
                ['code', 'codeblock'],
                ['scrollSync'],
            ];

        const editor = new window.toastui.Editor({
            el: host,
            // Let CSS flex give the editor its size; Toast UI will fill the host.
            height: '100%',
            initialValue: draft.content || '',
            initialEditType: 'wysiwyg',     // WYSIWYG by default (per requirements)
            previewStyle: 'vertical',
            usageStatistics: false,
            hideModeSwitch: true,            // WYSIWYG only — hide the Markdown tab
            placeholder: 'Write your note here…',
            toolbarItems: toolbar,
            autofocus: true,
            events: {
                change: function () {
                    state.editingDraft.content = editor.getMarkdown();
                },
            },
        });
        state.mdEditor = editor;
        state.mdEditorKind = 'toast';

        // Ctrl/Cmd+S → save  |  Esc → cancel — bound on the editor surface.
        // We attach in capture phase so it wins over Toast UI's own handlers.
        const root = host.querySelector('.toastui-editor-defaultUI') || host;
        root.addEventListener('keydown', function (ev) {
            if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
                ev.preventDefault();
                ev.stopPropagation();
                state.editingDraft.content = editor.getMarkdown();
                saveDraft(statusEl);
            } else if (ev.key === 'Escape' && !state.saving) {
                ev.preventDefault();
                cancelEdit();
            }
        }, true);

        // Place focus sensibly.
        setTimeout(function () {
            try {
                editor.focus();
                editor.moveCursorToEnd();
            } catch (_e) { /* non-fatal */ }
        }, 30);
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
        teardownEditor();
        state.editing = false;
        state.previewMode = false;
        state.editingDraft = null;
        render();
    }

    /** Detach the rich-text editor (if mounted) so it doesn't leak across re-renders. */
    function teardownEditor() {
        if (state.mdEditor) {
            try {
                // Toast UI Editor exposes destroy(); EasyMDE used toTextArea().
                if (typeof state.mdEditor.destroy === 'function') {
                    state.mdEditor.destroy();
                } else if (typeof state.mdEditor.toTextArea === 'function') {
                    state.mdEditor.toTextArea();
                }
            } catch (_e) { /* ignore */ }
        }
        state.mdEditor = null;
        state.mdEditorKind = null;
    }

    /**
     * Confirm + delete a note. The backend moves the file into
     * `.joplin-trash/` so Joplin's sync stops seeing it (deletion
     * propagates to all clients) but the bytes are preserved on disk.
     */
    function confirmDeleteNote(note) {
        if (state.saving || state.deleting) return;
        const title = (note && note.title) ? note.title : '(untitled)';
        showConfirm({
            title: 'Delete note?',
            message: 'Are you sure you want to delete "' + title + '"? ' +
                     'It will be moved into the Joplin trash folder and removed from every Joplin client on the next sync.',
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: function () { deleteNote(note.id); },
        });
    }

    function deleteNote(id) {
        if (!id || state.deleting) return;
        state.deleting = true;
        setSyncStatus('syncing', 'Deleting note…');
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
                showToast('Note deleted', 'success');
                setSyncStatus('ok', 'Synced');
                return loadTree().then(function () { render(); });
            })
            .catch(function (err) {
                state.deleting = false;
                const msg = (err.body && err.body.message) || err.message || 'Delete failed';
                setSyncStatus('error', msg);
                showToast(msg, 'error');
                render();
            });
    }

    // ---------- Notebook (folder) actions ----------------------------------

    /** Create a notebook under the currently-selected folder (or root). */
    function promptCreateFolder() {
        const sel = state.selectedFolder;
        const parentId = (sel && sel !== '__ALL__' && state.folders[sel]) ? sel : null;
        const parentLabel = parentId ? state.folders[parentId].title : 'top level';

        showPrompt({
            title: 'New notebook',
            message: 'Create a new notebook under "' + parentLabel + '".',
            placeholder: 'Notebook name',
            confirmLabel: 'Create',
            onConfirm: function (value) {
                const title = (value || '').trim();
                if (title === '') {
                    showToast('Notebook name is required', 'error');
                    return;
                }
                createFolder(title, parentId);
            },
        });
    }

    function createFolder(title, parentId) {
        setSyncStatus('syncing', 'Creating notebook…');
        apiSend(apiUrl('/api/folder'), 'POST', {
            title: title,
            parent_id: parentId || '',
        })
            .then(function (res) {
                showToast('Notebook created', 'success');
                setSyncStatus('ok', 'Synced');
                // Auto-expand parent so the new notebook is visible.
                if (parentId) state.expanded[parentId] = true;
                return loadTree().then(function () {
                    if (res && res.id) state.selectedFolder = res.id;
                    render();
                });
            })
            .catch(function (err) {
                const msg = (err.body && err.body.message) || err.message || 'Create failed';
                setSyncStatus('error', msg);
                showToast(msg, 'error');
            });
    }

    function promptRenameFolder(folder) {
        showPrompt({
            title: 'Rename notebook',
            message: 'Enter a new name for "' + (folder.title || '(untitled)') + '".',
            initialValue: folder.title || '',
            placeholder: 'Notebook name',
            confirmLabel: 'Rename',
            onConfirm: function (value) {
                const title = (value || '').trim();
                if (title === '') {
                    showToast('Notebook name is required', 'error');
                    return;
                }
                if (title === (folder.title || '').trim()) return; // no-op
                renameFolder(folder.id, title);
            },
        });
    }

    function renameFolder(id, title) {
        setSyncStatus('syncing', 'Renaming…');
        apiSend(apiUrl('/api/folder/' + encodeURIComponent(id)), 'PUT', { title: title })
            .then(function () {
                showToast('Notebook renamed', 'success');
                setSyncStatus('ok', 'Synced');
                return loadTree().then(function () { render(); });
            })
            .catch(function (err) {
                const msg = (err.body && err.body.message) || err.message || 'Rename failed';
                setSyncStatus('error', msg);
                showToast(msg, 'error');
            });
    }

    /**
     * Confirm + delete a notebook. Fetches descendant counts first so the
     * confirmation dialog can show the user exactly what they're about to
     * lose. The backend cascades the delete to every sub-notebook + note.
     */
    function confirmDeleteFolder(folder) {
        if (state.deleting) return;
        const title = folder.title || '(untitled)';

        // Best-effort — if the count fails, still let the user proceed
        // with a generic warning.
        fetchJson(apiUrl('/api/folder/' + encodeURIComponent(folder.id) + '/descendants'))
            .catch(function () { return { folders: 0, notes: 0 }; })
            .then(function (counts) {
                const subFolders = counts.folders || 0;
                const subNotes   = counts.notes   || 0;
                let extra = '';
                if (subNotes > 0 || subFolders > 0) {
                    const parts = [];
                    if (subNotes   > 0) parts.push(subNotes + ' note' + (subNotes === 1 ? '' : 's'));
                    if (subFolders > 0) parts.push(subFolders + ' sub-notebook' + (subFolders === 1 ? '' : 's'));
                    extra = ' This will also delete ' + parts.join(' and ') + ' inside it.';
                }
                showConfirm({
                    title: 'Delete notebook?',
                    message: 'Are you sure you want to delete "' + title + '"?' + extra +
                             ' All affected files are moved to the Joplin trash folder and will be removed from every Joplin client on the next sync.',
                    confirmLabel: 'Delete',
                    danger: true,
                    onConfirm: function () { deleteFolder(folder.id); },
                });
            });
    }

    function deleteFolder(id) {
        if (!id || state.deleting) return;
        state.deleting = true;
        setSyncStatus('syncing', 'Deleting notebook…');
        render();

        apiSend(apiUrl('/api/folder/' + encodeURIComponent(id)), 'DELETE', {})
            .then(function (res) {
                state.deleting = false;
                // If the deleted notebook (or one of its descendants) was the
                // currently-selected one, fall back to "All notes".
                if (state.selectedFolder === id ||
                    (state.folders[state.selectedFolder] &&
                     !state.folders[state.selectedFolder]) /* no-op */) {
                    state.selectedFolder = '__ALL__';
                }
                state.selectedNote = null;
                state.loadedNote   = null;

                const tn = (res && res.trashed_notes)   || 0;
                const tf = (res && res.trashed_folders) || 0;
                const total = tn + tf;
                showToast('Notebook deleted (' + total + ' item' + (total === 1 ? '' : 's') + ')', 'success');
                setSyncStatus('ok', 'Synced');
                return loadTree().then(function () {
                    // If selectedFolder no longer exists in fresh index, reset.
                    if (state.selectedFolder !== '__ALL__' && !state.folders[state.selectedFolder]) {
                        state.selectedFolder = '__ALL__';
                    }
                    render();
                });
            })
            .catch(function (err) {
                state.deleting = false;
                const msg = (err.body && err.body.message) || err.message || 'Delete failed';
                setSyncStatus('error', msg);
                showToast(msg, 'error');
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
            teardownEditor();
            state.editingDraft = null;
            showToast(d.isNew ? 'Note created' : 'Note saved', 'success');

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
        state.loading = true;
        setSyncStatus('syncing', 'Refreshing index…');
        render();
        return fetchJson(apiUrl('/api/reindex'), { method: 'POST' })
            .then(function (resp) {
                if (window.console && console.info) {
                    console.info('[Joplin] reindex complete', resp);
                }
                return loadTree();
            })
            .then(function () {
                state.loading = false;
                setSyncStatus('ok', 'Synced');
                showToast('Index refreshed', 'success');
                // If the previously-selected note still exists, re-select it.
                if (prevSelected && state.notes[prevSelected]) {
                    selectNote(prevSelected);
                } else {
                    state.selectedNote = null;
                    state.loadedNote = null;
                    render();
                }
            })
            .catch(function (err) {
                state.loading = false;
                setSyncStatus('error', err.message || 'Reindex failed');
                render();
                showToast('Reindex failed: ' + err.message, 'error');
            });
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

    const app = { root: null, notebooks: null, list: null, viewer: null, overlay: null, backdrop: null };

    function buildLayout() {
        const root = document.getElementById('joplin-app');
        root.innerHTML = '';
        app.root = root;

        // Three-panel: notebooks | notes list | viewer/editor
        app.notebooks = el('div', { class: 'joplin-pane joplin-pane-notebooks' });
        app.list      = el('div', { class: 'joplin-pane joplin-pane-list' });
        app.viewer    = el('div', { class: 'joplin-pane joplin-pane-viewer' });

        app.backdrop = el('div', {
            class: 'joplin-backdrop',
            onclick: function () { state.sidebarOpen = false; render(); },
        });

        root.appendChild(app.notebooks);
        root.appendChild(app.list);
        root.appendChild(app.backdrop);
        root.appendChild(app.viewer);

        // Global loading overlay
        app.overlay = el('div', { class: 'joplin-overlay' }, [
            el('div', { class: 'joplin-overlay-card' }, [
                el('div', { class: 'joplin-overlay-spinner' }),
                el('div', { class: 'joplin-overlay-text', text: 'Working…' }),
            ]),
        ]);
        root.appendChild(app.overlay);
    }

    function render() {
        if (!app.root) return;
        renderNotebooksPane(app.notebooks);
        renderNotesPane(app.list);
        // While the rich Markdown editor is active, avoid rebuilding the
        // viewer pane on unrelated state ticks (search input, sync pill, …)
        // — that would tear down Toast UI and lose cursor/preview state.
        const editorMounted = !!(state.mdEditor && state.editing);
        // Toggle pane styling: edit mode removes padding/overflow so the
        // editor can fill the entire pane height/width.
        if (app.viewer) {
            app.viewer.classList.toggle('joplin-editing-mode', !!state.editing);
        }
        if (!editorMounted) {
            renderViewer(app.viewer);
        } else {
            // Keep the Save button label / disabled state in sync with
            // state.saving while the editor stays mounted.
            const saveBtn = app.viewer.querySelector('.joplin-editor-actions button.primary');
            if (saveBtn) {
                saveBtn.textContent = state.saving ? 'Saving…' : 'Save';
                if (state.saving) saveBtn.setAttribute('disabled', 'disabled');
                else saveBtn.removeAttribute('disabled');
            }
            const cancelBtn = app.viewer.querySelector('.joplin-editor-actions button:not(.primary)');
            if (cancelBtn) {
                if (state.saving) cancelBtn.setAttribute('disabled', 'disabled');
                else cancelBtn.removeAttribute('disabled');
            }
        }
        // Sidebar / overlay state
        app.root.classList.toggle('joplin-sidebar-open', !!state.sidebarOpen);
        app.root.classList.toggle('joplin-busy', !!(state.loading || state.deleting));
        if (app.overlay) {
            app.overlay.classList.toggle('visible', !!(state.loading || state.deleting));
            const t = app.overlay.querySelector('.joplin-overlay-text');
            if (t) t.textContent = state.deleting ? 'Deleting…' : (state.loading ? 'Refreshing…' : 'Working…');
        }
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

    function showError(msg) { showToast(msg, 'error', 5000); }
    function showInfo(msg)  { showToast(msg, 'info'); }

    /** Toast variants: 'info' | 'success' | 'error'. */
    function showToast(msg, variant, duration) {
        const root = document.getElementById('joplin-app') || document.body;
        const existing = root.querySelector('.joplin-toast');
        if (existing) existing.remove();
        const v = variant || 'info';
        const icon = v === 'success' ? '✓' : v === 'error' ? '!' : 'i';
        const toast = el('div', { class: 'joplin-toast joplin-toast-' + v, role: 'status' }, [
            el('span', { class: 'joplin-toast-icon', text: icon }),
            el('span', { class: 'joplin-toast-msg', text: msg }),
        ]);
        root.appendChild(toast);
        // Force reflow then animate in
        requestAnimationFrame(function () { toast.classList.add('visible'); });
        setTimeout(function () {
            if (!toast.parentNode) return;
            toast.classList.remove('visible');
            setTimeout(function () { if (toast.parentNode) toast.remove(); }, 200);
        }, duration || 2500);
    }

    /** Custom confirmation modal — replaces window.confirm() for richer UX. */
    function showConfirm(opts) {
        opts = opts || {};
        const root = document.getElementById('joplin-app') || document.body;
        const existing = root.querySelector('.joplin-modal-backdrop');
        if (existing) existing.remove();

        function close() {
            if (modal.parentNode) modal.remove();
            document.removeEventListener('keydown', onKey);
        }
        function onKey(ev) {
            if (ev.key === 'Escape') { ev.preventDefault(); close(); }
            if (ev.key === 'Enter')  { ev.preventDefault(); close(); if (opts.onConfirm) opts.onConfirm(); }
        }

        const confirmBtn = el('button', {
            class: 'joplin-modal-btn ' + (opts.danger ? 'danger' : 'primary'),
            text: opts.confirmLabel || 'Confirm',
            onclick: function () { close(); if (opts.onConfirm) opts.onConfirm(); },
        });
        const cancelBtn = el('button', {
            class: 'joplin-modal-btn',
            text: opts.cancelLabel || 'Cancel',
            onclick: function () { close(); if (opts.onCancel) opts.onCancel(); },
        });

        const modal = el('div', { class: 'joplin-modal-backdrop',
            onclick: function (ev) { if (ev.target === modal) close(); } }, [
            el('div', { class: 'joplin-modal', role: 'dialog', 'aria-modal': 'true' }, [
                el('div', { class: 'joplin-modal-header' }, [
                    el('h2', { class: 'joplin-modal-title', text: opts.title || 'Confirm' }),
                ]),
                el('div', { class: 'joplin-modal-body', text: opts.message || '' }),
                el('div', { class: 'joplin-modal-actions' }, [cancelBtn, confirmBtn]),
            ]),
        ]);
        root.appendChild(modal);
        document.addEventListener('keydown', onKey);
        setTimeout(function () { confirmBtn.focus(); }, 0);
    }

    /**
     * Modal text-input prompt — used for create/rename notebook flows.
     * Replaces window.prompt() so we get consistent styling and Esc/Enter
     * handling across the app.
     */
    function showPrompt(opts) {
        opts = opts || {};
        const root = document.getElementById('joplin-app') || document.body;
        const existing = root.querySelector('.joplin-modal-backdrop');
        if (existing) existing.remove();

        function close() {
            if (modal.parentNode) modal.remove();
            document.removeEventListener('keydown', onKey);
        }
        function submit() {
            const v = input.value;
            close();
            if (opts.onConfirm) opts.onConfirm(v);
        }
        function onKey(ev) {
            if (ev.key === 'Escape') { ev.preventDefault(); close(); }
            if (ev.key === 'Enter')  { ev.preventDefault(); submit(); }
        }

        const input = el('input', {
            type: 'text',
            class: 'joplin-modal-input',
            placeholder: opts.placeholder || '',
            value: opts.initialValue || '',
            'aria-label': opts.title || 'Value',
        });
        const confirmBtn = el('button', {
            class: 'joplin-modal-btn primary',
            text: opts.confirmLabel || 'OK',
            onclick: submit,
        });
        const cancelBtn = el('button', {
            class: 'joplin-modal-btn',
            text: opts.cancelLabel || 'Cancel',
            onclick: function () { close(); if (opts.onCancel) opts.onCancel(); },
        });

        const modal = el('div', { class: 'joplin-modal-backdrop',
            onclick: function (ev) { if (ev.target === modal) close(); } }, [
            el('div', { class: 'joplin-modal', role: 'dialog', 'aria-modal': 'true' }, [
                el('div', { class: 'joplin-modal-header' }, [
                    el('h2', { class: 'joplin-modal-title', text: opts.title || 'Enter value' }),
                ]),
                el('div', { class: 'joplin-modal-body' }, [
                    opts.message ? el('p', { class: 'joplin-modal-message', text: opts.message }) : null,
                    input,
                ].filter(Boolean)),
                el('div', { class: 'joplin-modal-actions' }, [cancelBtn, confirmBtn]),
            ]),
        ]);
        root.appendChild(modal);
        document.addEventListener('keydown', onKey);
        setTimeout(function () {
            input.focus();
            // Pre-select existing text so rename overwriting is one keystroke.
            if (input.value) input.select();
        }, 0);
    }

    /**
     * Set the small sync-status pill rendered in the sidebar header.
     * Levels: 'idle' | 'syncing' | 'ok' | 'error'.
     * `ok` and `error` automatically fade back to `idle` after 3s so the
     * pill doesn't permanently sit on the last result.
     */
    let _syncStatusTimer = null;
    function setSyncStatus(level, message) {
        state.syncStatus = level || 'idle';
        state.syncStatusMessage = message || '';
        if (_syncStatusTimer) { clearTimeout(_syncStatusTimer); _syncStatusTimer = null; }
        if (level === 'ok' || level === 'error') {
            _syncStatusTimer = setTimeout(function () {
                state.syncStatus = 'idle';
                state.syncStatusMessage = '';
                _syncStatusTimer = null;
                render();
            }, 3000);
        }
        render();
    }

    // ---------- Boot --------------------------------------------------------

    function boot() {
        buildLayout();
        state.loading = true;
        render();
        loadTree()
            .then(function () { state.loading = false; render(); })
            .catch(function (err) {
                state.loading = false;
                render();
                showError('Failed to load Joplin index: ' + err.message);
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
