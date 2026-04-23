<?php
declare(strict_types=1);

namespace OCA\Joplin\Service;

use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use Psr\Log\LoggerInterface;

/**
 * Writes Joplin-compatible note files into the user's Joplin sync folder.
 *
 *  - Create:  generate a 32-char hex ID, build a fresh "title\n\nbody\n\n<meta>" file.
 *  - Update:  preserve the existing metadata block; only the title (first line)
 *             and body are overwritten. updated_time / user_updated_time are bumped.
 *
 * Joplin reads its sync target by directory listing + mtime; nothing else is required
 * for the new/updated note to appear in every Joplin client at the next sync.
 *
 * SAFETY GUARANTEES
 *  - The metadata block we write contains only the documented Joplin keys
 *    (matches what joplin-desktop produces for the FileSystem sync target).
 *  - When updating, we never touch keys other than `updated_time` and
 *    `user_updated_time` — id / parent_id / type_ / created_time and any
 *    plugin-specific keys are kept verbatim.
 *  - We refuse to write while the user holds an exclusive Joplin sync lock
 *    (`.locks/exclusive_*.json`) so we never collide with an in-flight sync
 *    from another client.
 *  - All writes go through Nextcloud's File API (`File::putContent`) which
 *    performs a temp-write + rename internally → no partial files visible
 *    on disk.
 */
class JoplinWriter {

    public function __construct(
        private IRootFolder $rootFolder,
        private JoplinIndexService $index,
        private JoplinParser $parser,
        private LoggerInterface $logger,
    ) {}

    /**
     * @return array{id:string, path:string}
     * @throws \RuntimeException on validation / lock / write failure
     */
    public function createNote(string $userId, ?string $parentId, string $title, string $body): array {
        $title = $this->cleanTitle($title);
        $body  = $this->normaliseBody($body);

        if ($title === '' && trim($body) === '') {
            throw new \RuntimeException('Note must have a title or body');
        }
        if ($parentId !== null && !$this->isValidJoplinId($parentId)) {
            throw new \RuntimeException('Invalid parent_id');
        }

        $root = $this->index->resolveRoot($userId);
        if ($root === null) {
            throw new \RuntimeException('No Joplin sync folder configured for this user');
        }
        $this->assertNotLocked($root);

        // Verify parent exists if provided
        if ($parentId !== null) {
            $idx = $this->index->getIndex($userId);
            if ($idx === null || !isset($idx['folders'][$parentId])) {
                throw new \RuntimeException('Parent notebook not found');
            }
        }

        $id  = $this->generateId();
        $iso = $this->isoNow();

        $contents = $this->buildNewNoteFile($id, $parentId, $title, $body, $iso);

        $filename = $id . '.md';
        try {
            // Belt-and-braces: refuse to overwrite an existing file with the
            // same generated id (statistically impossible, but check anyway).
            if ($root->nodeExists($filename)) {
                throw new \RuntimeException('Generated id already exists, aborting');
            }
            $file = $root->newFile($filename, $contents);
        } catch (\Throwable $e) {
            $this->logger->error('Joplin: failed to create note', [
                'user' => $userId, 'id' => $id, 'exception' => $e,
            ]);
            throw new \RuntimeException('Could not write note: ' . $e->getMessage(), 0, $e);
        }

        // Force a fresh index next call so the new note appears immediately.
        $this->index->getIndex($userId, true);

        $this->logger->info('Joplin: note created', [
            'user' => $userId, 'id' => $id, 'parent' => $parentId, 'path' => $file->getPath(),
        ]);

        return ['id' => $id, 'path' => $file->getPath()];
    }

    /**
     * @return array{id:string, mtime:int}
     * @throws \RuntimeException
     */
    public function updateNote(string $userId, string $id, string $title, string $body): array {
        if (!$this->isValidJoplinId($id)) {
            throw new \RuntimeException('Invalid note id');
        }
        $title = $this->cleanTitle($title);
        $body  = $this->normaliseBody($body);

        if ($title === '' && trim($body) === '') {
            throw new \RuntimeException('Note must have a title or body');
        }

        $root = $this->index->resolveRoot($userId);
        if ($root === null) {
            throw new \RuntimeException('No Joplin sync folder configured for this user');
        }
        $this->assertNotLocked($root);

        $filename = $id . '.md';
        try {
            $file = $root->get($filename);
        } catch (NotFoundException $e) {
            throw new \RuntimeException('Note not found');
        }
        if (!($file instanceof File)) {
            throw new \RuntimeException('Note path is not a file');
        }

        $current = $file->getContent();
        $parsed  = $this->parser->parse($current);
        if ($parsed['type'] !== 1) {
            throw new \RuntimeException('Refusing to edit a non-note entry (type_ != 1)');
        }
        if (($parsed['id'] ?? '') !== $id) {
            // Filename id and metadata id mismatch — bail rather than guess.
            throw new \RuntimeException('Note id mismatch between filename and metadata');
        }

        // Keep every existing metadata key. Bump only the timestamps.
        $metadata = $parsed['metadata'];
        $iso = $this->isoNow();
        $metadata['updated_time']      = $iso;
        $metadata['user_updated_time'] = $iso;

        $newContents = $this->buildFileFromParts($title, $body, $metadata);

        try {
            $file->putContent($newContents);
        } catch (\Throwable $e) {
            $this->logger->error('Joplin: failed to update note', [
                'user' => $userId, 'id' => $id, 'exception' => $e,
            ]);
            throw new \RuntimeException('Could not save note: ' . $e->getMessage(), 0, $e);
        }

        $this->index->getIndex($userId, true);

        $this->logger->info('Joplin: note updated', [
            'user' => $userId, 'id' => $id, 'path' => $file->getPath(),
        ]);

        return ['id' => $id, 'mtime' => $file->getMTime()];
    }

    /**
     * Soft-delete a note by moving its file out of the Joplin sync root
     * into a hidden trash subfolder (`.joplin-trash/`).
     *
     * Why a subfolder rather than `unlink()`?
     *  - The Joplin filesystem sync target only scans the sync ROOT (flat).
     *    Files placed in a subdirectory are completely invisible to every
     *    Joplin client's sync scan.
     *  - Each Joplin client, on its next sync, sees the file is missing
     *    from the root → marks the corresponding note as deleted locally
     *    → propagates that deletion through its own sync state.
     *  - The original bytes are preserved in `.joplin-trash/`, so an
     *    accidental delete can be recovered by an admin (or a future
     *    "restore" UI) by simply moving the file back into the root.
     *  - Because the metadata block (id / parent_id / type_) is untouched,
     *    a restore will be re-picked up by Joplin sync as the SAME note.
     *
     * @return array{id:string, trashed_path:string}
     * @throws \RuntimeException
     */
    public function deleteNote(string $userId, string $id): array {
        if (!$this->isValidJoplinId($id)) {
            throw new \RuntimeException('Invalid note id');
        }

        $root = $this->index->resolveRoot($userId);
        if ($root === null) {
            throw new \RuntimeException('No Joplin sync folder configured for this user');
        }
        $this->assertNotLocked($root);

        $filename = $id . '.md';
        try {
            $file = $root->get($filename);
        } catch (NotFoundException $e) {
            throw new \RuntimeException('Note not found');
        }
        if (!($file instanceof File)) {
            throw new \RuntimeException('Note path is not a file');
        }

        // Sanity: refuse to "delete" anything that isn't a real Joplin note
        // (type_ == 1). This protects notebooks (type_ == 2) and revision
        // deltas (type_ == 13) from being accidentally trashed by a misrouted
        // request.
        $parsed = $this->parser->parse($file->getContent());
        if (($parsed['type'] ?? 0) !== 1) {
            throw new \RuntimeException('Refusing to delete a non-note entry (type_ != 1)');
        }
        if (($parsed['id'] ?? '') !== $id) {
            throw new \RuntimeException('Note id mismatch between filename and metadata');
        }

        // Ensure trash folder exists (hidden from Joplin's flat root scan).
        $trash = null;
        try {
            $trash = $root->get('.joplin-trash');
            if (!($trash instanceof Folder)) {
                throw new \RuntimeException('.joplin-trash exists but is not a folder');
            }
        } catch (NotFoundException $e) {
            try {
                $trash = $root->newFolder('.joplin-trash');
            } catch (\Throwable $ex) {
                throw new \RuntimeException(
                    'Could not create trash folder: ' . $ex->getMessage(), 0, $ex
                );
            }
        }

        // Disambiguate filename in trash if a previous tombstone exists.
        $stamp     = gmdate('Ymd-His');
        $trashName = $id . '.' . $stamp . '.md';
        if ($trash->nodeExists($trashName)) {
            $trashName = $id . '.' . $stamp . '-' . substr(bin2hex(random_bytes(3)), 0, 6) . '.md';
        }

        try {
            $file->move($trash->getPath() . '/' . $trashName);
        } catch (\Throwable $e) {
            $this->logger->error('Joplin: failed to trash note', [
                'user' => $userId, 'id' => $id, 'exception' => $e,
            ]);
            throw new \RuntimeException('Could not delete note: ' . $e->getMessage(), 0, $e);
        }

        // Force a fresh index next call so the deleted note disappears.
        $this->index->getIndex($userId, true);

        $this->logger->info('Joplin: note moved to trash', [
            'user' => $userId, 'id' => $id, 'trashed_as' => $trashName,
        ]);

        return ['id' => $id, 'trashed_path' => $trash->getPath() . '/' . $trashName];
    }

    // ------------------------------------------------------------------
    //  File-format builders
    // ------------------------------------------------------------------

    /**
     * Build a fresh Joplin sync file. Uses the canonical key set produced
     * by joplin-desktop ≥ 2.x for the FileSystem sync target.
     */
    private function buildNewNoteFile(
        string $id,
        ?string $parentId,
        string $title,
        string $body,
        string $isoNow
    ): string {
        $metadata = [
            'id'                     => $id,
            'parent_id'              => $parentId ?? '',
            'created_time'           => $isoNow,
            'updated_time'           => $isoNow,
            'is_conflict'            => '0',
            'latitude'               => '0.00000000',
            'longitude'              => '0.00000000',
            'altitude'               => '0.0000',
            'author'                 => '',
            'source_url'             => '',
            'is_todo'                => '0',
            'todo_due'               => '0',
            'todo_completed'         => '0',
            'source'                 => 'nextcloud',
            'source_application'     => 'net.nextcloud.joplin',
            'application_data'       => '',
            'order'                  => '0',
            'user_created_time'      => $isoNow,
            'user_updated_time'      => $isoNow,
            'encryption_cipher_text' => '',
            'encryption_applied'     => '0',
            'markup_language'        => '1',           // 1 = Markdown
            'is_shared'              => '0',
            'share_id'               => '',
            'conflict_original_id'   => '',
            'master_key_id'          => '',
            'user_data'              => '',
            'deleted_time'           => '0',
            'type_'                  => '1',           // 1 = note
        ];

        return $this->buildFileFromParts($title, $body, $metadata);
    }

    /**
     * Assemble "title\n\nbody\n\n<metadata block>".
     *
     * @param array<string,string> $metadata
     */
    private function buildFileFromParts(string $title, string $body, array $metadata): string {
        // Body is allowed to be empty.
        $bodyClean = rtrim($body, "\r\n");

        // Canonical Joplin sync file format (matches what joplin-desktop writes):
        //   title\n
        //   \n                    <-- blank line
        //   body\n                (omitted entirely when body is empty)
        //   \n                    <-- blank line before metadata block
        //   key: value\n          (one per metadata key)
        //   ...
        //   type_: 1\n
        //
        // The blank line BEFORE the metadata block is critical: without it,
        // Joplin's markdown parser treats `id:`/`parent_id:`/etc. as part of
        // the body, then re-escapes them on re-save (e.g. `type_:` → `type\_:`),
        // which corrupts the metadata and causes the client to skip the note.

        $head = $title . "\n\n";
        if ($bodyClean !== '') {
            $head .= $bodyClean . "\n\n";
        }

        $metaLines = [];
        foreach ($metadata as $k => $v) {
            // Joplin metadata is single-line "key: value". Strip embedded newlines
            // defensively so we never corrupt the metadata block parser.
            $vSafe = preg_replace('/\s+/', ' ', (string) $v) ?? '';
            $metaLines[] = $k . ': ' . $vSafe;
        }

        // CRITICAL: do NOT append a trailing newline after the metadata block.
        // Joplin's parser scans the file bottom-up and switches to "body" mode
        // the moment it encounters a blank line. A trailing "\n" produces an
        // empty final element when the parser does content.split("\n"), which
        // immediately flips it into body-reading mode → every metadata key
        // (including type_) is mis-classified as body → Joplin rejects the
        // file with "Missing required property: type_".
        // Joplin's own serializer ends the file at the last key with no
        // trailing newline; we mirror that exactly.
        return $head . implode("\n", $metaLines);
    }

    // ------------------------------------------------------------------
    //  Validation / helpers
    // ------------------------------------------------------------------

    private function cleanTitle(string $title): string {
        // Normalise whitespace, strip leading "#" markers (if user typed a heading)
        $t = trim(preg_replace('/\s+/', ' ', $title) ?? '');
        $t = ltrim($t, "# \t");
        return $t;
    }

    private function normaliseBody(string $body): string {
        return str_replace(["\r\n", "\r"], "\n", $body);
    }

    private function isValidJoplinId(string $id): bool {
        return (bool) preg_match('/^[0-9a-f]{32}$/', $id);
    }

    private function generateId(): string {
        // 32 lowercase hex chars — same shape as Joplin's IDs.
        return bin2hex(random_bytes(16));
    }

    private function isoNow(): string {
        // Joplin uses ISO-8601 with millisecond precision and a trailing Z.
        $now  = (float) microtime(true);
        $secs = (int) $now;
        $ms   = (int) round(($now - $secs) * 1000);
        if ($ms === 1000) { $secs++; $ms = 0; }
        return gmdate('Y-m-d\TH:i:s', $secs) . sprintf('.%03dZ', $ms);
    }

    /**
     * Refuse to write while a Joplin "exclusive" sync lock is held in
     * .locks/. Short sync locks are ignored — only the long-lived exclusive
     * lock (used during big migrations / encryption changes) blocks us.
     */
    private function assertNotLocked(Folder $root): void {
        try {
            $locks = $root->get('.locks');
        } catch (NotFoundException $e) {
            return;
        }
        if (!($locks instanceof Folder)) {
            return;
        }
        foreach ($locks->getDirectoryListing() as $f) {
            if ($f instanceof File && str_starts_with($f->getName(), 'exclusive_')) {
                throw new \RuntimeException(
                    'Joplin is currently performing an exclusive sync operation. '
                    . 'Please wait for it to finish and try again.'
                );
            }
        }
    }
}
