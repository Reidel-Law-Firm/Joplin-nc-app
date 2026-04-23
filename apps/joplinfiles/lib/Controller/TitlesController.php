<?php
declare(strict_types=1);

namespace OCA\JoplinFiles\Controller;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\JSONResponse;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\IRequest;

class TitlesController extends Controller {

    public function __construct(
        string $appName,
        IRequest $request,
        private IRootFolder $rootFolder,
        private string $userId,
    ) {
        parent::__construct($appName, $request);
    }

    /**
     * Return a map of { "guid.md" => "Note Title" } for a Joplin sync folder.
     * Returns an empty object if the folder is not a Joplin folder (no info.json).
     *
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function getTitles(string $path = '/'): JSONResponse {
        $userFolder = $this->rootFolder->getUserFolder($this->userId);

        // Resolve the requested folder safely within the user's storage
        $normalizedPath = ltrim($path, '/');
        try {
            $node = $normalizedPath === '' ? $userFolder : $userFolder->get($normalizedPath);
        } catch (NotFoundException $e) {
            return new JSONResponse([]);
        }

        if (!($node instanceof Folder)) {
            return new JSONResponse([]);
        }

        // Verify this is a Joplin sync folder. Joplin writes one of:
        //   - info.json                 (legacy sync target v1)
        //   - .sync/version.txt         (sync target v2/v3 — current)
        if (!$this->isJoplinFolder($node)) {
            return new JSONResponse([]);
        }

        $titles = [];

        // Joplin sync-folder system entries that should never appear to the
        // user in the Files view. Hidden via the same __joplin_hide__ marker
        // used for revision deltas; the front-end injects a CSS rule that
        // matches both file rows and folder rows.
        $systemEntries = [
            'info.json'      => true,
            'locks'          => true,
            'temp'           => true,
            '.joplin-trash'  => true,
            '.lock'          => true,
            '.resource'      => true,
            '.sync'          => true,
        ];

        foreach ($node->getDirectoryListing() as $child) {
            $name = $child->getName();

            // Hide Joplin-internal system files/folders unconditionally.
            if (isset($systemEntries[$name])) {
                $titles[$name] = '__joplin_hide__';
                continue;
            }

            if (!($child instanceof File)) {
                continue;
            }

            // Joplin note/notebook files are exactly 32 lowercase hex chars + ".md"
            if (!preg_match('/^[0-9a-f]{32}\.md$/i', $name)) {
                continue;
            }

            try {
                // Stream the file — read only the first non-empty line that
                // doesn't look like a Joplin metadata key (e.g. "id: ...").
                // Files that are *only* metadata (revisions, resources, etc.)
                // get a special "__joplin_hide__" marker so the front-end
                // can hide their row entirely from the Files list.
                $stream = $child->fopen('r');
                if ($stream === false) {
                    continue;
                }

                $title = '';
                $isMetadataOnly = false;
                while (($line = fgets($stream)) !== false) {
                    $trimmed = trim($line);
                    if ($trimmed === '') {
                        continue;
                    }
                    // Strip UTF-8 BOM on the very first line
                    if ($title === '' && strncmp($trimmed, "\xEF\xBB\xBF", 3) === 0) {
                        $trimmed = substr($trimmed, 3);
                        if ($trimmed === '') {
                            continue;
                        }
                    }
                    // Metadata-only entries (revisions / type_:13 / resources)
                    // start with a "key: value" line. Mark them for hiding.
                    if (preg_match('/^[a-z][a-z0-9_]*:\s/', $trimmed)) {
                        $isMetadataOnly = true;
                        break;
                    }
                    // Strip leading "#" if the title was stored as a heading
                    $title = ltrim($trimmed, "# \t");
                    break;
                }
                fclose($stream);

                if ($isMetadataOnly) {
                    $titles[$name] = '__joplin_hide__';
                } elseif ($title !== '') {
                    $titles[$name] = $title;
                }
            } catch (\Throwable $e) {
                // Skip unreadable files silently
            }
        }

        return new JSONResponse($titles);
    }

    /**
     * Detect a Joplin sync folder by either of the canonical markers:
     *   - info.json                 (legacy sync v1)
     *   - .sync/version.txt         (sync v2/v3 — current)
     */
    private function isJoplinFolder(Folder $folder): bool {
        try {
            if ($folder->get('info.json') instanceof File) {
                return true;
            }
        } catch (NotFoundException $e) {
            // fall through
        }
        try {
            $sync = $folder->get('.sync');
            if ($sync instanceof Folder && $sync->get('version.txt') instanceof File) {
                return true;
            }
        } catch (NotFoundException $e) {
            // not Joplin
        }
        return false;
    }
}
