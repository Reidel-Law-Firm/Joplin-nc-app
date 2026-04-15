/**
 * joplinfiles — Nextcloud Files display-name overlay for Joplin sync folders.
 *
 * Detects Joplin sync folders (identified by the presence of info.json) and
 * replaces the GUID-based .md filenames shown in the Files UI with the actual
 * note titles stored as the first line of each file.
 *
 * This is a self-contained, pre-built script that requires no bundler.
 * To rebuild from the ESM source run:  npm ci && npm run build
 */
(function () {
    'use strict';

    /** Map<dir, { filename: title }> — only set on successful non-empty fetch */
    var titleCache = new Map();

    /** Re-entrancy guard */
    var applying = false;

    /** Last directory we processed */
    var lastDir = '';

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function getApiUrl() {
        // Try OC.generateUrl first (handles webroot / index.php automatically)
        if (typeof OC !== 'undefined' && typeof OC.generateUrl === 'function') {
            return OC.generateUrl('/apps/joplinfiles/titles');
        }
        // Fallback: try index.php prefix which works even without pretty URLs
        return window.location.origin + '/index.php/apps/joplinfiles/titles';
    }

    function getCurrentDir() {
        return new URL(window.location.href).searchParams.get('dir') || '';
    }

    // -------------------------------------------------------------------------
    // API call — only caches on success so failed requests are retried
    // -------------------------------------------------------------------------

    async function fetchTitles(dir) {
        if (titleCache.has(dir)) {
            return titleCache.get(dir);
        }

        var url = getApiUrl() + '?path=' + encodeURIComponent(dir);

        try {
            var res = await fetch(url, { credentials: 'same-origin' });

            if (!res.ok) {
                return {};
            }

            var json = await res.json();

            var keys = Object.keys(json || {});
            if (keys.length === 0) {
                titleCache.set(dir, {});
                return {};
            }

            titleCache.set(dir, json);
            return json;

        } catch (err) {
            return {};
        }
    }

    // -------------------------------------------------------------------------
    // DOM patching — tries multiple selector strategies for NC compatibility
    // -------------------------------------------------------------------------

    function applyTitles(titles) {
        if (applying) return;
        if (!titles || Object.keys(titles).length === 0) return;

        // Find all file rows — NC28+ uses data-cy-files-list-row-name
        var rows = document.querySelectorAll('tr[data-cy-files-list-row-name]');

        if (rows.length === 0) {
            return;
        }

        applying = true;
        try {
            rows.forEach(function (row) {
                var filename = row.getAttribute('data-cy-files-list-row-name');
                if (!filename || !titles[filename]) return;

                var title = titles[filename];

                // Strategy 1: NC28 standard selectors
                var trimmable = row.querySelector('.files-list__row-name-trimmable');
                var extSpan   = row.querySelector('.files-list__row-name-ext');

                if (trimmable) {
                    if (trimmable.dataset.joplinTitle === title) return; // already done
                    trimmable.textContent         = title;
                    trimmable.dataset.joplinTitle = title;
                    trimmable.title               = title + '  (' + filename + ')';
                    if (extSpan) extSpan.textContent = '';
                    return;
                }

                // Strategy 2: any span inside the name cell that holds the filename stem
                var nameCell = row.querySelector('td[class*="row-name"], td.files-list__row-name');
                if (!nameCell) return;

                var spans = nameCell.querySelectorAll('span');
                for (var i = 0; i < spans.length; i++) {
                    var s = spans[i];
                    // Find the span whose text matches the GUID stem (without extension)
                    var stem = filename.replace(/\.md$/i, '');
                    if (s.textContent.trim() === stem || s.textContent.trim() === filename) {
                        if (s.dataset.joplinTitle === title) return;
                        s.textContent         = title;
                        s.dataset.joplinTitle = title;
                        s.title               = title + '  (' + filename + ')';
                        // Hide sibling extension spans
                        var parent = s.parentNode;
                        if (parent) {
                            parent.querySelectorAll('span[class*="ext"]').forEach(function(e) {
                                e.textContent = '';
                            });
                        }
                        break;
                    }
                }
            });
        } finally {
            applying = false;
        }
    }

    // -------------------------------------------------------------------------
    // Navigation detection & orchestration
    // -------------------------------------------------------------------------

    async function checkAndUpdate() {
        var dir = getCurrentDir();
        if (!dir) return;

        if (dir !== lastDir) {
            lastDir = dir;
            var titles = await fetchTitles(dir);
            applyTitles(titles);
        } else if (titleCache.has(dir) && Object.keys(titleCache.get(dir)).length > 0) {
            applyTitles(titleCache.get(dir));
        }
    }

    // -------------------------------------------------------------------------
    // MutationObserver — re-applies titles after Vue re-renders rows
    // -------------------------------------------------------------------------

    function startObserver() {
        var target =
            document.getElementById('app-content') ||
            document.getElementById('content') ||
            document.querySelector('[id*="app-content"]') ||
            document.querySelector('.app-content-wrapper') ||
            document.body;

        new MutationObserver(function () {
            var dir = getCurrentDir();
            if (dir && titleCache.has(dir) && Object.keys(titleCache.get(dir)).length > 0) {
                applyTitles(titleCache.get(dir));
            }
        }).observe(target, { childList: true, subtree: true });
    }

    // -------------------------------------------------------------------------
    // Bootstrap
    // -------------------------------------------------------------------------

    function init() {
        startObserver();
        setInterval(checkAndUpdate, 800);
        checkAndUpdate();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
