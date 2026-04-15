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

        // Verify this is a Joplin sync folder — Joplin always writes info.json here
        try {
            $node->get('info.json');
        } catch (NotFoundException $e) {
            return new JSONResponse([]);
        }

        $titles = [];

        foreach ($node->getDirectoryListing() as $child) {
            if (!($child instanceof File)) {
                continue;
            }

            $name = $child->getName();

            // Joplin note/notebook files are exactly 32 lowercase hex chars + ".md"
            if (!preg_match('/^[0-9a-f]{32}\.md$/i', $name)) {
                continue;
            }

            try {
                // Stream the file — read only the first non-empty line (the title)
                $stream = $child->fopen('r');
                if ($stream === false) {
                    continue;
                }

                $title = '';
                while (($line = fgets($stream)) !== false) {
                    $trimmed = trim($line);
                    if ($trimmed !== '') {
                        $title = $trimmed;
                        break;
                    }
                }
                fclose($stream);

                if ($title !== '') {
                    $titles[$name] = $title;
                }
            } catch (\Throwable $e) {
                // Skip unreadable files silently
            }
        }

        return new JSONResponse($titles);
    }
}
