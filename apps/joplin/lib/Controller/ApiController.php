<?php
declare(strict_types=1);

namespace OCA\Joplin\Controller;

use OCA\Joplin\Service\JoplinIndexService;
use OCA\Joplin\Service\JoplinWriter;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

class ApiController extends Controller {

    public function __construct(
        string $appName,
        IRequest $request,
        private JoplinIndexService $index,
        private JoplinWriter $writer,
        private LoggerInterface $logger,
        private ?string $userId,
    ) {
        parent::__construct($appName, $request);
    }

    /**
     * Wrap a JSONResponse with no-cache headers so newly-synced notes
     * are never hidden by a stale browser/proxy cache.
     */
    private function fresh(JSONResponse $r): JSONResponse {
        $r->addHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        $r->addHeader('Pragma', 'no-cache');
        $r->addHeader('Expires', '0');
        return $r;
    }

    /**
     * Returns the notebook tree + notes list metadata.
     *
     * @NoAdminRequired
     */
    public function tree(): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'not_authenticated'], Http::STATUS_UNAUTHORIZED);
        }

        try {
            $idx = $this->index->getIndex($this->userId);
        } catch (\Throwable $e) {
            $this->logger->error('Joplin: tree build failed', ['exception' => $e]);
            return new JSONResponse(['error' => 'index_failed', 'message' => $e->getMessage()],
                Http::STATUS_INTERNAL_SERVER_ERROR);
        }

        if ($idx === null) {
            return $this->fresh(new JSONResponse([
                'configured' => $this->index->getConfiguredRoot($this->userId),
                'found'      => false,
                'folders'    => [],
                'notes'      => [],
            ]));
        }

        // Strip search snippets from the wire payload — keep it compact
        $notes = [];
        foreach ($idx['notes'] as $id => $n) {
            $notes[] = [
                'id'        => $n['id'],
                'title'     => $n['title'],
                'parent_id' => $n['parent_id'],
                'mtime'     => $n['mtime'],
            ];
        }

        $folders = [];
        foreach ($idx['folders'] as $id => $f) {
            $folders[] = [
                'id'        => $f['id'],
                'title'     => $f['title'],
                'parent_id' => $f['parent_id'],
                'mtime'     => $f['mtime'],
            ];
        }

        return $this->fresh(new JSONResponse([
            'configured' => $this->index->getConfiguredRoot($this->userId),
            'found'      => true,
            'root'       => $idx['root'],
            'built_at'   => $idx['built_at'],
            'folders'    => $folders,
            'notes'      => $notes,
        ]));
    }

    /**
     * @NoAdminRequired
     */
    public function note(string $id): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'not_authenticated'], Http::STATUS_UNAUTHORIZED);
        }
        if (!preg_match('/^[0-9a-f]{32}$/i', $id)) {
            return new JSONResponse(['error' => 'invalid_id'], Http::STATUS_BAD_REQUEST);
        }

        try {
            $note = $this->index->getNote($this->userId, strtolower($id));
        } catch (\Throwable $e) {
            $this->logger->error('Joplin: note load failed', ['id' => $id, 'exception' => $e]);
            return new JSONResponse(['error' => 'read_failed'], Http::STATUS_INTERNAL_SERVER_ERROR);
        }

        if ($note === null) {
            return new JSONResponse(['error' => 'not_found'], Http::STATUS_NOT_FOUND);
        }
        return new JSONResponse($note);
    }

    /**
     * Create a new Joplin note.
     *
     * Body parameters:
     *   - title  (string, optional — defaults to "Untitled")
     *   - body   (string, optional)
     *   - parent_id (string, optional — 32-hex notebook id; root if omitted)
     *
     * @NoAdminRequired
     */
    public function createNote(string $title = '', string $body = '', string $parent_id = ''): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'not_authenticated'], Http::STATUS_UNAUTHORIZED);
        }

        $parent = $parent_id !== '' ? strtolower($parent_id) : null;
        $title  = trim($title) === '' ? 'Untitled' : $title;

        try {
            $res = $this->writer->createNote($this->userId, $parent, $title, $body);
        } catch (\Throwable $e) {
            $this->logger->warning('Joplin: createNote failed', [
                'user' => $this->userId, 'exception' => $e,
            ]);
            return new JSONResponse(
                ['error' => 'create_failed', 'message' => $e->getMessage()],
                Http::STATUS_BAD_REQUEST
            );
        }

        // Return the freshly-loaded note so the client can immediately render it.
        $note = $this->index->getNote($this->userId, $res['id']);
        return $this->fresh(new JSONResponse([
            'ok'   => true,
            'id'   => $res['id'],
            'note' => $note,
        ], Http::STATUS_CREATED));
    }

    /**
     * Update an existing Joplin note's title + body.
     *
     * The metadata block is preserved verbatim (id, parent_id, type_,
     * created_time, plugin keys, …) — only updated_time and
     * user_updated_time are bumped.
     *
     * @NoAdminRequired
     */
    public function updateNote(string $id, string $title = '', string $body = ''): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'not_authenticated'], Http::STATUS_UNAUTHORIZED);
        }
        if (!preg_match('/^[0-9a-f]{32}$/i', $id)) {
            return new JSONResponse(['error' => 'invalid_id'], Http::STATUS_BAD_REQUEST);
        }
        $title = trim($title) === '' ? 'Untitled' : $title;

        try {
            $this->writer->updateNote($this->userId, strtolower($id), $title, $body);
        } catch (\Throwable $e) {
            $this->logger->warning('Joplin: updateNote failed', [
                'user' => $this->userId, 'id' => $id, 'exception' => $e,
            ]);
            return new JSONResponse(
                ['error' => 'update_failed', 'message' => $e->getMessage()],
                Http::STATUS_BAD_REQUEST
            );
        }

        $note = $this->index->getNote($this->userId, strtolower($id));
        return $this->fresh(new JSONResponse([
            'ok'   => true,
            'id'   => strtolower($id),
            'note' => $note,
        ]));
    }

    /**
     * Delete (soft-delete) a Joplin note.
     *
     * The file is moved into `.joplin-trash/` inside the sync root rather
     * than unlinked, so:
     *   - Joplin's flat-root sync scan stops seeing it (deletion propagates
     *     to every Joplin client on next sync, just like a real delete).
     *   - The original bytes (id / parent_id / metadata / body) are
     *     preserved on disk and can be restored by moving the file back.
     *
     * @NoAdminRequired
     */
    public function deleteNote(string $id): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'not_authenticated'], Http::STATUS_UNAUTHORIZED);
        }
        if (!preg_match('/^[0-9a-f]{32}$/i', $id)) {
            return new JSONResponse(['error' => 'invalid_id'], Http::STATUS_BAD_REQUEST);
        }

        try {
            $res = $this->writer->deleteNote($this->userId, strtolower($id));
        } catch (\Throwable $e) {
            $this->logger->warning('Joplin: deleteNote failed', [
                'user' => $this->userId, 'id' => $id, 'exception' => $e,
            ]);
            $msg = $e->getMessage();
            $status = str_contains($msg, 'not found')
                ? Http::STATUS_NOT_FOUND
                : Http::STATUS_BAD_REQUEST;
            return new JSONResponse(
                ['error' => 'delete_failed', 'message' => $msg],
                $status
            );
        }

        return $this->fresh(new JSONResponse([
            'ok' => true,
            'id' => $res['id'],
        ]));
    }

    /**
     * Search by title and indexed body snippet; for confirmed title hits
     * we additionally scan the full body to surface a matching excerpt.
     *
     * @NoAdminRequired
     */
    public function search(string $q = ''): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'not_authenticated'], Http::STATUS_UNAUTHORIZED);
        }
        $q = trim($q);
        if (mb_strlen($q) < 2) {
            return new JSONResponse(['query' => $q, 'results' => []]);
        }

        $idx = $this->index->getIndex($this->userId);
        if ($idx === null) {
            return new JSONResponse(['query' => $q, 'results' => []]);
        }

        $needle = mb_strtolower($q);
        $results = [];
        foreach ($idx['notes'] as $n) {
            $hitTitle   = mb_stripos($n['title'],   $needle) !== false;
            $hitSnippet = mb_stripos($n['snippet'] ?? '', $needle) !== false;
            if (!$hitTitle && !$hitSnippet) {
                continue;
            }

            $excerpt = $this->makeExcerpt($n['snippet'] ?? '', $needle);
            $results[] = [
                'id'        => $n['id'],
                'title'     => $n['title'],
                'parent_id' => $n['parent_id'],
                'mtime'     => $n['mtime'],
                'excerpt'   => $excerpt,
                'matched'   => $hitTitle ? 'title' : 'body',
            ];
            if (count($results) >= 100) {
                break;
            }
        }

        // For the first ~10 title hits we additionally open the full body to
        // produce a richer excerpt. Kept small to protect performance.
        foreach ($results as &$r) {
            if ($r['excerpt'] !== '' || $r['matched'] !== 'title') {
                continue;
            }
            $note = $this->index->getNote($this->userId, $r['id']);
            if ($note !== null) {
                $r['excerpt'] = $this->makeExcerpt($note['body'], $needle);
            }
        }
        unset($r);

        return new JSONResponse(['query' => $q, 'results' => $results]);
    }

    /**
     * @NoAdminRequired
     */
    public function reindex(): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'not_authenticated'], Http::STATUS_UNAUTHORIZED);
        }
        $idx = $this->index->getIndex($this->userId, true);
        return new JSONResponse([
            'rebuilt' => true,
            'found'   => $idx !== null,
            'notes'   => $idx !== null ? count($idx['notes']) : 0,
            'folders' => $idx !== null ? count($idx['folders']) : 0,
        ]);
    }

    /**
     * @NoAdminRequired
     */
    public function getRoot(): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'not_authenticated'], Http::STATUS_UNAUTHORIZED);
        }
        return new JSONResponse([
            'configured' => $this->index->getConfiguredRoot($this->userId),
        ]);
    }

    /**
     * @NoAdminRequired
     */
    public function setRoot(string $path = ''): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'not_authenticated'], Http::STATUS_UNAUTHORIZED);
        }
        // Prevent path-traversal style input
        if (strpos($path, '..') !== false) {
            return new JSONResponse(['error' => 'invalid_path'], Http::STATUS_BAD_REQUEST);
        }
        $this->index->setConfiguredRoot($this->userId, $path);
        return new JSONResponse(['ok' => true]);
    }

    /* ---------------------------------------------------------------- */

    private function makeExcerpt(string $haystack, string $needleLower): string {
        if ($haystack === '') {
            return '';
        }
        $haystack = preg_replace('/\s+/', ' ', $haystack) ?? '';
        $pos = mb_stripos($haystack, $needleLower);
        if ($pos === false) {
            return mb_substr($haystack, 0, 160);
        }
        $start = max(0, $pos - 60);
        $len   = 200;
        $excerpt = mb_substr($haystack, $start, $len);
        if ($start > 0) {
            $excerpt = '…' . $excerpt;
        }
        if (mb_strlen($haystack) > $start + $len) {
            $excerpt .= '…';
        }
        return $excerpt;
    }
}
