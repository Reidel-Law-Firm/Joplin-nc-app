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

function applyTitles(titles) {
    if (applying) return
    if (!titles || Object.keys(titles).length === 0) return

    applying = true
    try {
        document.querySelectorAll('tr[data-cy-files-list-row-name]').forEach(row => {
            const filename = row.getAttribute('data-cy-files-list-row-name')
            if (!filename || !titles[filename]) return

            const title      = titles[filename]
            const trimmable  = row.querySelector('.files-list__row-name-trimmable')
            const extSpan    = row.querySelector('.files-list__row-name-ext')

            if (!trimmable) return
            if (trimmable.dataset.joplinTitle === title) return   // already applied

            trimmable.textContent         = title
            trimmable.dataset.joplinTitle = title
            trimmable.title               = `${title}  (${filename})`

            if (extSpan) extSpan.textContent = ''
        })
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

function startObserver() {
    const target =
        document.getElementById('app-content') ||
        document.querySelector('.app-content-wrapper') ||
        document.body

    new MutationObserver(() => {
        const dir = getCurrentDir()
        if (dir && titleCache.has(dir)) applyTitles(titleCache.get(dir))
    }).observe(target, { childList: true, subtree: true })
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
    startObserver()
    setInterval(checkAndUpdate, 500)
    checkAndUpdate()
})
