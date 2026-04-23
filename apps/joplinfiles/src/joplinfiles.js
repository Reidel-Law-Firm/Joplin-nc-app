/**
 * joplinfiles — ESM source for webpack.
 *
 * Produces js/joplinfiles.js when built with:  npm ci && npm run build
 *
 * The pre-built js/joplinfiles.js is functionally identical and requires no
 * build step, so this file is only needed when you want to modify the app.
 */
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

/** Map<dir, { filename: title }> */
const titleCache = new Map()

/** Re-entrancy guard */
let applying = false

/** Last seen directory */
let lastDir = ''
/** Debounce timer for navigation events */
let navDebounceTimer = null

/** Set of filenames we want to hide via persistent CSS. */
const hiddenFilenames = new Set()
/** The single <style> element holding our hide rules. */
let hideStyleEl = null

function ensureHideStyle() {
    if (hideStyleEl && document.head.contains(hideStyleEl)) return hideStyleEl
    hideStyleEl = document.createElement('style')
    hideStyleEl.id = 'joplinfiles-hide-rules'
    document.head.appendChild(hideStyleEl)
    return hideStyleEl
}

function syncHideStyle() {
    if (hiddenFilenames.size === 0) {
        if (hideStyleEl) hideStyleEl.textContent = ''
        return
    }
    const selectors = []
    hiddenFilenames.forEach(fn => {
        // CSS attribute selector — escape backslashes and quotes defensively.
        const safe = fn.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        selectors.push(`tr[data-cy-files-list-row-name="${safe}"]`)
    })
    ensureHideStyle().textContent = selectors.join(',\n') + ' { display: none !important; }'
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

async function fetchTitles(dir) {
    if (titleCache.has(dir)) return titleCache.get(dir)

    let data = {}
    try {
        const res = await axios.get(generateUrl('/apps/joplinfiles/titles'), {
            params: { path: dir },
        })
        if (res.data && typeof res.data === 'object') {
            data = res.data
        }
    } catch (_) {
        // Not a Joplin folder or network error — cache empty so we don't retry
    }

    titleCache.set(dir, data)
    return data
}

// ---------------------------------------------------------------------------
// DOM patching
// ---------------------------------------------------------------------------

/**
 * Merge of all per-directory title maps we have ever fetched.
 * Used by the viewer / search patchers, which don't know which folder
 * the displayed item belongs to.
 */
const globalTitles = {}

const GUID_MD_RE = /^([0-9a-f]{32})\.md$/i

/** Try to find a matching Joplin title for any text node value. */
function lookupTitle(text) {
    if (!text) return null
    const trimmed = text.trim()
    if (globalTitles[trimmed]) return globalTitles[trimmed]
    // Some places display the basename without extension
    const m = trimmed.match(/^([0-9a-f]{32})$/i)
    if (m && globalTitles[`${m[1]}.md`]) return globalTitles[`${m[1]}.md`]
    return null
}

function applyTitles(titles) {
    if (applying) return
    if (!titles || Object.keys(titles).length === 0) return

    applying = true
    try {
        // Merge into the global map for the viewer / search patchers
        Object.assign(globalTitles, titles)

        // Collect filenames that should be hidden via CSS (persistent across re-renders).
        let hideListChanged = false
        Object.keys(titles).forEach(fn => {
            if (titles[fn] === '__joplin_hide__' && !hiddenFilenames.has(fn)) {
                hiddenFilenames.add(fn)
                hideListChanged = true
            }
        })
        if (hideListChanged) syncHideStyle()

        // ---- 1. File list rows ----------------------------------------
        document.querySelectorAll('tr[data-cy-files-list-row-name]').forEach(row => {
            const filename = row.getAttribute('data-cy-files-list-row-name')
            if (!filename || !titles[filename]) return

            const title = titles[filename]

            // Hide markers are handled by the persistent CSS rule above.
            if (title === '__joplin_hide__') return

            // The filename label has changed across Nextcloud versions:
            //   - NC 28-32 : .files-list__row-name-trimmable
            //   - NC 33+   : .files-list__row-name-text
            const label =
                row.querySelector('.files-list__row-name-text') ||
                row.querySelector('.files-list__row-name-trimmable')
            const extSpan = row.querySelector('.files-list__row-name-ext')

            if (!label) return
            if (label.dataset.joplinTitle === title) return

            label.textContent         = title
            label.dataset.joplinTitle = title
            label.title               = `${title}  (${filename})`

            if (extSpan) extSpan.textContent = ''
        })

        // ---- 2. Viewer modal header -----------------------------------
        // The Viewer app shows the basename in its header. Selector covers
        // both the Viewer modal and the in-app Text editor header.
        document.querySelectorAll(
            '.modal-header .modal-name, ' +
            '.modal-header__name, ' +
            '.viewer__file__name, ' +
            '[data-cy-viewer-file-name], ' +
            '.header-menu .header-title'
        ).forEach(el => {
            const t = lookupTitle(el.textContent)
            if (!t) return
            if (el.dataset.joplinTitle === t) return
            el.dataset.joplinTitle = t
            el.title = el.textContent.trim()  // keep the GUID as a tooltip
            el.textContent = t
        })

        // ---- 3. Browser tab title -------------------------------------
        if (document.title) {
            const t = lookupTitle(document.title.split(' - ')[0])
            if (t && !document.title.startsWith(t)) {
                const parts = document.title.split(' - ')
                parts[0] = t
                document.title = parts.join(' - ')
            }
        }

        // ---- 4. Header / unified search results -----------------------
        // The unified search popover renders result rows with the basename
        // inside `.unified-search__result-title` (NC 27+).
        document.querySelectorAll(
            '.unified-search__result-title, ' +
            '.unified-search__result-line-one, ' +
            '.search-result__title'
        ).forEach(el => {
            const t = lookupTitle(el.textContent)
            if (!t) return
            if (el.dataset.joplinTitle === t) return
            el.dataset.joplinTitle = t
            el.title = el.textContent.trim()
            el.textContent = t
        })

        // ---- 5. Generic fallback --------------------------------------
        // Walk visible text nodes that look exactly like a Joplin GUID
        // filename and replace them. Limited to short text nodes to keep
        // it cheap.
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue) return NodeFilter.FILTER_REJECT
                const v = node.nodeValue.trim()
                if (v.length < 32 || v.length > 40) return NodeFilter.FILTER_REJECT
                return GUID_MD_RE.test(v) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
            },
        })
        let n
        while ((n = walker.nextNode())) {
            const t = lookupTitle(n.nodeValue)
            if (t) n.nodeValue = t
        }
    } finally {
        applying = false
    }
}

// ---------------------------------------------------------------------------
// Navigation & orchestration
// ---------------------------------------------------------------------------

function getCurrentDir() {
    return new URL(window.location.href).searchParams.get('dir') || ''
}

async function checkAndUpdate() {
    const dir = getCurrentDir()
    if (!dir) return

    if (dir !== lastDir) {
        lastDir = dir
        const titles = await fetchTitles(dir)
        applyTitles(titles)
    } else if (titleCache.has(dir)) {
        applyTitles(titleCache.get(dir))
    }
}

// ---------------------------------------------------------------------------
// Navigation detection — covers popstate (back/forward) AND
// pushState/replaceState (Nextcloud SPA internal folder navigation)
// ---------------------------------------------------------------------------

function onNavigate() {
    clearTimeout(navDebounceTimer)
    navDebounceTimer = setTimeout(() => {
        lastDir = ''
        checkAndUpdate()
    }, 50)
}

function patchHistoryApi() {
    ;['pushState', 'replaceState'].forEach(method => {
        const original = history[method]
        history[method] = function (...args) {
            original.apply(history, args)
            onNavigate()
        }
    })
    window.addEventListener('popstate', onNavigate)
}

function startObserver() {
    const target =
        document.getElementById('app-content') ||
        document.querySelector('.app-content-wrapper') ||
        document.body

    new MutationObserver(() => {
        // Always re-apply using the merged global map so that the
        // viewer modal / unified-search popover (which mount lazily,
        // after the file list has already been patched) get rewritten.
        if (Object.keys(globalTitles).length) applyTitles(globalTitles)
    }).observe(target, { childList: true, subtree: true })

    // Also observe the document body for late-mounted modals/popovers
    if (target !== document.body) {
        new MutationObserver(() => {
            if (Object.keys(globalTitles).length) applyTitles(globalTitles)
        }).observe(document.body, { childList: true, subtree: true })
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
    patchHistoryApi()
    startObserver()
    setInterval(checkAndUpdate, 500)
    checkAndUpdate()
})
