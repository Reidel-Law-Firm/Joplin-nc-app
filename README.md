# Joplin for Nextcloud

This repository contains two Nextcloud custom apps:

| App | ID | Purpose |
|---|---|---|
| **Joplin File Titles** | `joplinfiles` | Display Joplin note titles instead of GUID filenames in Nextcloud Files |
| **Joplin** | `joplin-nc-app` | A dedicated notes app (header entry) that browses, reads and searches your Joplin notes |

Both apps can be enabled side-by-side and are fully independent. Neither modifies any Joplin files on disk, and neither touches Joplin's sync mechanism.

---

## Joplin app (`joplin-nc-app`)

A native-feeling Nextcloud app that reads the Joplin data already synced to your
Nextcloud account and surfaces it as a browsable notes app.

### Features

- **Header navigation entry** — appears next to Files, Photos, etc.
- **Notebook tree** — reconstructed from Joplin's `parent_id` metadata
- **Notes list** — human-readable titles (from first line / first heading), sorted by last modified
- **Markdown viewer** — read-only, renders headings, lists, code, tables, links, images…
- **Search** — title + indexed body snippet; full-body scan for title matches
- **Auto-detection** — finds the Joplin folder via the `info.json` marker (up to 3 levels deep)
- **Manual root override** — if auto-detect fails, configure the path from the UI
- **Indexed** — a lightweight per-user index is cached (5 min TTL); the "Reload" button forces a rebuild
- **Read-only** — the app never writes to, renames, or otherwise modifies any `.md` file
- **No external dependencies** — vanilla JS, no build step, no CDN assets

### Architecture

```
apps/joplin-nc-app/
├── appinfo/
│   ├── info.xml              # App metadata + <navigations> entry
│   └── routes.php            # Page + API routes
├── css/joplin.css            # Three-pane layout styles
├── img/
│   ├── app.svg               # Header menu icon (monochrome)
│   └── joplin.svg            # Larger app icon
├── js/joplin-main.js         # Pre-built SPA (vanilla JS, no bundler)
├── lib/
│   ├── AppInfo/Application.php
│   ├── Controller/
│   │   ├── PageController.php   # Serves the SPA shell
│   │   └── ApiController.php    # JSON API (tree / note / search / reindex / root)
│   └── Service/
│       ├── JoplinParser.php        # Parses one Joplin .md file (title/body/metadata)
│       └── JoplinIndexService.php  # Builds + caches the per-user index
└── templates/main.php
```

### API Endpoints

All endpoints are user-authenticated (Nextcloud session + request token).

| Method | URL | Description |
|---|---|---|
| `GET` | `/apps/joplin-nc-app/` | SPA page |
| `GET` | `/apps/joplin-nc-app/api/tree` | Full index — folders + notes metadata (no bodies) |
| `GET` | `/apps/joplin-nc-app/api/note/{id}` | Full note: title, rendered-ready body, timestamps |
| `GET` | `/apps/joplin-nc-app/api/search?q=…` | Search results (title + snippet), max 100 |
| `POST` | `/apps/joplin-nc-app/api/reindex` | Force rebuild of the index |
| `GET` | `/apps/joplin-nc-app/api/root` | Current configured root folder path |
| `POST` | `/apps/joplin-nc-app/api/root` | Set root folder (form field `path`, relative to files root) |

### Data-handling layer — how notes are parsed

A Joplin `<guid>.md` file on disk looks like:

```
My note title

# Optional body heading
The body content, in Markdown…

id: 93b58f6f0b404dc5908b7bfc0b8d4879
parent_id: 52ac…
created_time: 2024-05-01T08:12:33.000Z
updated_time: 2024-05-03T16:44:12.000Z
type_: 1
```

`JoplinParser::parse()` walks from the end of the file collecting contiguous
`key: value` lines to isolate the metadata block; the first non-empty line is
the title; everything between is the body. A lightweight
`parseHeader()` variant is used at index time — it reads only the first 512
bytes (for the title) and the last 4 KiB (for the metadata) so indexing a
large sync folder never loads full bodies into memory.

Folders (Joplin notebooks) are just `.md` files with `type_: 2`. The tree is
reconstructed purely from their `parent_id` fields.

### Performance

- **Two-tier parse** — headers are streamed (~4.5 KiB read per file) at index time; full bodies only loaded when a note is opened.
- **Cached index** — stored via `ICacheFactory::createDistributed` per user (5-min TTL).
- **Lazy search** — search runs over the cached index + small body snippets; only title-match results optionally fall back to full-body scanning.

### Error handling

- Missing Joplin folder → UI offers a manual-path prompt (stored as a user setting).
- Unparseable / oversized files → skipped with a debug log, do not break the index.
- Note-load failures → surface a user-friendly error in the viewer pane.
- All endpoints return structured JSON error responses with appropriate HTTP status codes.

### Non-goals

- No editing (viewer is read-only).
- No changes to Joplin's sync protocol, file naming, or metadata format.
- No rewriting or renaming of any `.md` file.

### Installation & testing

```bash
# 1. Start the stack (Nextcloud + MariaDB)
docker compose up -d

# 2. Enable the app
docker compose exec --user www-data nextcloud php occ app:enable joplin

# 3. Open http://localhost:8080 — log in as admin / admin123
#    The "Joplin" app appears in the header navigation.

# 4. In the Files app, upload or sync a Joplin folder
#    (a directory that contains "info.json" + <guid>.md files).

# 5. Click the Joplin header entry — the app auto-detects the folder.
#    If it doesn't, enter the path (e.g. "Joplin") in the prompt.

# Force a re-index anytime via the "Reload" button in the notes pane,
# or from the CLI:
docker compose exec --user www-data nextcloud php occ config:user:set <user> joplin joplin_root_path --value="Joplin"
```

### Upgrade / disable

```bash
docker compose exec --user www-data nextcloud php occ app:disable joplin-nc-app
docker compose exec --user www-data nextcloud php occ app:enable  joplin-nc-app
```

---

# Project Structure

```
Joplin-nc-app/
├── docker-compose.yml              # Local development environment
└── apps/
    └── joplinfiles/                # Joplin File Titles app
        ├── appinfo/
        │   ├── info.xml            # App metadata
        │   └── routes.php          # API route definitions
        ├── lib/
        │   ├── AppInfo/
        │   │   └── Application.php # App bootstrap
        │   ├── Controller/
        │   │   └── TitlesController.php  # Reads Joplin note titles server-side
        │   └── Listener/
        │       └── LoadAdditionalScripts.php    # Injects JS into the Files page
        ├── src/
        │   └── joplinfiles.js      # Frontend ESM source (Webpack entry)
        ├── js/
        │   └── joplinfiles.js      # Pre-built JS (ready to use, no build step needed)
        ├── package.json
        └── webpack.config.js
```

---

# Joplin File Titles

When you use [Joplin](https://joplinapp.org/) with Nextcloud synchronisation, notes are stored as `.md` files named with 32-character hex GUIDs (e.g. `93b58f6f0b404dc5908b7bfc0b8d4879.md`). This app replaces those unreadable names in the Nextcloud Files UI with the actual note titles stored inside each file — **without renaming any files on disk**.

---

## Features

- **Automatic detection** — identifies Joplin sync folders by the presence of Joplin's `info.json` marker file
- **Title extraction** — reads the first line of each GUID-named `.md` file as the note title (how Joplin stores it)
- **Display-only patch** — only the visual label in the Files list is changed; filenames on disk are untouched
- **No configuration needed** — works automatically for any Joplin sync folder in any user's storage
- **SPA-aware** — uses a `MutationObserver` + URL polling to re-apply titles after Vue re-renders the list
- **No build step required** — `js/joplinfiles.js` is a pre-built, self-contained script

---

## How It Works

1. When the Nextcloud Files page loads, the app's JavaScript polls the current folder URL every 800 ms.
2. On entering a new folder it calls `GET /apps/joplinfiles/titles?path=<dir>`.
3. The PHP controller checks for `info.json` in that folder. If absent, it returns `{}` and nothing changes.
4. If present, it streams the first non-empty line from every file matching `/^[0-9a-f]{32}\.md$/` and returns a JSON map of `{ "guid.md": "Note Title" }`.
5. The JavaScript patches the `<span>` elements in each file row with the returned titles. The original GUID is preserved in the element's `title` attribute (visible on hover).

---

## API Endpoints

| Method | URL | Description | Auth |
|---|---|---|---|
| `GET` | `/apps/joplinfiles/titles?path=<dir>` | Returns `{ filename: title }` map for a Joplin folder | User |

---

## Installation

### Via Docker (Development)

No build step required — `js/joplinfiles.js` is already compiled.

```bash
# Clone the repository
git clone <repo-url>
cd Joplin-nc-app

# Start Nextcloud + MariaDB
docker compose up -d
```

Nextcloud will be available at **http://localhost:8080**.

Default credentials:
- **Admin user**: `admin`
- **Admin password**: `admin123`

The `apps/` directory is mounted as `custom_apps` inside the container, so the app is immediately visible to Nextcloud.

**Enable the app:**

```bash
docker compose exec --user www-data nextcloud php occ app:enable joplinfiles
```

### Manual Installation

Copy `apps/joplinfiles` into your Nextcloud `custom_apps` (or `apps`) folder, then enable the app:

```bash
php occ app:enable joplinfiles
```

### Disable / Re-enable

```bash
docker compose exec --user www-data nextcloud php occ app:disable joplinfiles
docker compose exec --user www-data nextcloud php occ app:enable joplinfiles
```

---

## Building the Frontend (optional)

The pre-built `js/joplinfiles.js` is ready to use. To rebuild from the ESM source:

```bash
cd apps/joplinfiles
npm install
npm run build   # production build → js/joplinfiles.js
npm run dev     # development build (unminified)
```

---

## Technology Stack

| Layer | Technology |
|---|---|
| Backend | PHP 8.1+, Nextcloud App Framework |
| Frontend | Vanilla JavaScript (ES2020), self-contained IIFE |
| HTTP client | `@nextcloud/axios` |
| Routing | `@nextcloud/router` |
| File actions | `@nextcloud/files` |
| Development DB | MariaDB 10.6 |
| Container runtime | Docker / Docker Compose |

---

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**, in accordance with Nextcloud's app licensing requirements. See [https://www.gnu.org/licenses/agpl-3.0.html](https://www.gnu.org/licenses/agpl-3.0.html) for details.

