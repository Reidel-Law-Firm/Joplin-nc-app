# Joplin File Titles – Nextcloud App

This repository contains a Nextcloud custom app:

| App | ID | Purpose |
|---|---|---|
| **Joplin File Titles** | `joplinfiles` | Display Joplin note titles instead of GUID filenames in Nextcloud Files |

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

