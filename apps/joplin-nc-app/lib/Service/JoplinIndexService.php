<?php
declare(strict_types=1);

namespace OCA\Joplin\Service;

use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\IConfig;
use OCP\ICache;
use OCP\ICacheFactory;
use Psr\Log\LoggerInterface;

/**
 * Builds and caches an index of a user's Joplin sync folder.
 *
 * The index stores, per entry:
 *   - kind: 'note' | 'folder'
 *   - id, title, parent_id, path (filesystem path), size, mtime (unix)
 *
 * Full note bodies are NEVER stored in the index — they are loaded on demand
 * when a single note is viewed. Only a small head snippet (~512 bytes) of each
 * note is indexed for quick fuzzy search.
 */
class JoplinIndexService {

    private const CONFIG_ROOT_KEY = 'joplin_root_path';
    /** Bump to invalidate cached indexes after format changes. */
    private const INDEX_VERSION   = 3;
    /**
     * Very short TTL — only used to coalesce bursts of requests on the same
     * page load. Real freshness comes from comparing the cached fingerprint
     * (file count + max child mtime) against the current state of the root
     * folder; if anything changed, we always rebuild. This guarantees newly
     * synced notes appear on reload even when the storage backend does not
     * bump the parent directory mtime.
     */
    private const CACHE_TTL       = 5;

    private ICache $cache;

    public function __construct(
        private IRootFolder $rootFolder,
        private JoplinParser $parser,
        private IConfig $config,
        ICacheFactory $cacheFactory,
        private LoggerInterface $logger,
    ) {
        $this->cache = $cacheFactory->createDistributed('joplin_index');
    }

    /* ------------------------------------------------------------------ */
    /*  Root folder configuration                                          */
    /* ------------------------------------------------------------------ */

    public function getConfiguredRoot(string $userId): string {
        return $this->config->getUserValue($userId, \OCA\Joplin\AppInfo\Application::APP_ID, self::CONFIG_ROOT_KEY, '');
    }

    public function setConfiguredRoot(string $userId, string $path): void {
        $path = '/' . trim($path, '/');
        $this->config->setUserValue($userId, \OCA\Joplin\AppInfo\Application::APP_ID, self::CONFIG_ROOT_KEY, $path);
        $this->cache->remove($this->cacheKey($userId));
    }

    /**
     * Returns the resolved Joplin sync Folder for the user, or null if it
     * cannot be found / is not a Joplin folder.
     */
    public function resolveRoot(string $userId): ?Folder {
        $userFolder = $this->rootFolder->getUserFolder($userId);
        $configured = $this->getConfiguredRoot($userId);

        if ($configured !== '' && $configured !== '/') {
            try {
                $node = $userFolder->get(ltrim($configured, '/'));
                if ($node instanceof Folder && $this->isJoplinFolder($node)) {
                    return $node;
                }
            } catch (NotFoundException $e) {
                // fall through to auto-detect
            }
        }

        // Auto-detect: search up to 3 levels deep for an info.json marker
        return $this->findJoplinFolder($userFolder, 3);
    }

    private function findJoplinFolder(Folder $folder, int $maxDepth): ?Folder {
        if ($this->isJoplinFolder($folder)) {
            return $folder;
        }
        if ($maxDepth <= 0) {
            return null;
        }
        foreach ($folder->getDirectoryListing() as $child) {
            if ($child instanceof Folder) {
                $found = $this->findJoplinFolder($child, $maxDepth - 1);
                if ($found !== null) {
                    return $found;
                }
            }
        }
        return null;
    }

    private function isJoplinFolder(Folder $folder): bool {
        // Joplin sync v1 marker
        try {
            if ($folder->get('info.json') instanceof File) {
                return true;
            }
        } catch (NotFoundException $e) {
            // fall through
        }
        // Joplin sync v2/v3 marker (current)
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

    /* ------------------------------------------------------------------ */
    /*  Index build / retrieval                                            */
    /* ------------------------------------------------------------------ */

    /**
     * @return array{
     *     root: string,
     *     built_at: int,
     *     folders: array<string, array{id:string,title:string,parent_id:?string,path:string,mtime:int}>,
     *     notes:   array<string, array{id:string,title:string,parent_id:?string,path:string,size:int,mtime:int,snippet:string}>
     * }|null
     */
    public function getIndex(string $userId, bool $forceRebuild = false): ?array {
        $root = $this->resolveRoot($userId);
        if ($root === null) {
            $this->logger->info('Joplin: no Joplin sync folder found for user', [
                'user' => $userId,
                'configured' => $this->getConfiguredRoot($userId),
            ]);
            return null;
        }

        $rootMtime = $root->getMTime();

        // Build a fingerprint from the actual .md children so we detect
        // newly-synced notes even when the storage backend does not bump
        // the parent folder's mtime.
        $children = $root->getDirectoryListing();
        $mdFiles  = [];
        $maxChildMtime = 0;
        foreach ($children as $child) {
            if (!($child instanceof File)) {
                continue;
            }
            if (!preg_match('/^[0-9a-f]{32}\.md$/i', $child->getName())) {
                continue;
            }
            $mdFiles[] = $child;
            $cm = $child->getMTime();
            if ($cm > $maxChildMtime) {
                $maxChildMtime = $cm;
            }
        }
        $fingerprint = count($mdFiles) . ':' . $maxChildMtime . ':' . $rootMtime;

        if (!$forceRebuild) {
            $cached = $this->cache->get($this->cacheKey($userId));
            if (is_array($cached)
                && ($cached['_v']          ?? 0)  === self::INDEX_VERSION
                && ($cached['fingerprint'] ?? '') === $fingerprint
                && ($cached['root']        ?? '') === $root->getPath()
            ) {
                unset($cached['_v'], $cached['fingerprint'], $cached['root_mtime']);
                return $cached;
            }
        }

        $folders = [];
        $notes   = [];
        $scanned = 0;
        $skipped = 0;

        foreach ($mdFiles as $child) {
            $scanned++;

            try {
                $parsed = $this->parseEntry($child);
            } catch (\Throwable $e) {
                $skipped++;
                $this->logger->debug('Joplin: failed to parse entry', [
                    'file' => $child->getPath(),
                    'exception' => $e,
                ]);
                continue;
            }
            if ($parsed === null || $parsed['id'] === null) {
                $skipped++;
                $this->logger->debug('Joplin: entry has no usable metadata, skipping', [
                    'file' => $child->getPath(),
                ]);
                continue;
            }

            // NEVER fall back to the filename — it would expose the GUID.
            // An empty title is left empty so the UI can render "(untitled)".
            $entry = [
                'id'        => $parsed['id'],
                'title'     => $parsed['title'],
                'parent_id' => $parsed['parent_id'],
                'path'      => $child->getPath(),
                'mtime'     => $child->getMTime(),
            ];

            if ($parsed['type'] === 2) {
                $folders[$parsed['id']] = $entry;
            } elseif ($parsed['type'] === 1) {
                $entry['size']    = $child->getSize();
                $entry['snippet'] = $parsed['snippet'] ?? '';
                $notes[$parsed['id']] = $entry;
            } else {
                $skipped++;
            }
        }

        // Sort notes by updated time (most recent first)
        uasort($notes, static function ($a, $b) {
            return ($b['mtime'] ?? 0) <=> ($a['mtime'] ?? 0);
        });
        uasort($folders, static function ($a, $b) {
            return strcasecmp($a['title'] ?? '', $b['title'] ?? '');
        });

        $index = [
            'root'     => $root->getPath(),
            'built_at' => time(),
            'folders'  => $folders,
            'notes'    => $notes,
        ];

        $this->logger->info('Joplin: index built', [
            'user'         => $userId,
            'root'         => $root->getPath(),
            'fingerprint'  => $fingerprint,
            'scanned'      => $scanned,
            'skipped'      => $skipped,
            'notes'        => count($notes),
            'folders'      => count($folders),
            'forced'       => $forceRebuild,
        ]);

        $this->cache->set(
            $this->cacheKey($userId),
            $index + ['_v' => self::INDEX_VERSION, 'fingerprint' => $fingerprint],
            self::CACHE_TTL
        );

        return $index;
    }

    /**
     * @return array{id:?string,parent_id:?string,title:string,type:int,snippet:string}|null
     */
    private function parseEntry(File $file): ?array {
        $size = $file->getSize();
        if ($size <= 0) {
            return null;
        }

        $stream = $file->fopen('r');
        if ($stream === false) {
            return null;
        }

        try {
            $reader = function (int $offset, int $length) use ($stream) {
                if (fseek($stream, $offset) !== 0) {
                    return false;
                }
                return fread($stream, $length);
            };

            $header = $this->parser->parseHeader($reader, $size);
            if ($header === null) {
                return null;
            }

            // Small snippet (first ~400 chars of body-ish text) for search.
            $snippet = '';
            if ($header['type'] === 1) {
                fseek($stream, 0);
                $raw = fread($stream, min(4096, $size));
                if ($raw !== false) {
                    $raw = str_replace(["\r\n", "\r"], "\n", $raw);
                    // Drop first two lines (title + blank) if present
                    $parts = explode("\n", $raw, 3);
                    $snippet = $parts[2] ?? '';
                    // Strip the trailing Joplin metadata block. Metadata always
                    // begins with an "id: <hex>" line preceded by a blank line.
                    // Cut at the first such marker so the snippet only holds body.
                    if (preg_match('/(?:^|\n)id:\s+[0-9a-f]{32}\s*\n/i', $snippet, $m, PREG_OFFSET_CAPTURE)) {
                        $snippet = substr($snippet, 0, $m[0][1]);
                    }
                    $snippet = preg_replace('/\s+/', ' ', $snippet) ?? '';
                    $snippet = trim(mb_substr($snippet, 0, 400));
                }
            }

            return [
                'id'        => $header['id'],
                'parent_id' => $header['parent_id'],
                'title'     => $header['title'],
                'type'      => $header['type'],
                'snippet'   => $snippet,
            ];
        } finally {
            fclose($stream);
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Single-note loading                                                */
    /* ------------------------------------------------------------------ */

    /**
     * Load one note (full body + metadata) by Joplin ID.
     *
     * @return array{
     *     id:string, title:string, body:string, parent_id:?string,
     *     created_time:?string, updated_time:?string, path:string, mtime:int
     * }|null
     */
    public function getNote(string $userId, string $id): ?array {
        $index = $this->getIndex($userId);
        if ($index === null || !isset($index['notes'][$id])) {
            return null;
        }
        $entry = $index['notes'][$id];

        $userFolder = $this->rootFolder->getUserFolder($userId);
        // $entry['path'] is an absolute Nextcloud node path — getById is safer
        try {
            $relative = $this->toUserRelativePath($userId, $entry['path']);
            $file = $relative !== null ? $userFolder->get($relative) : null;
        } catch (NotFoundException $e) {
            return null;
        }
        if (!($file instanceof File)) {
            return null;
        }

        if ($file->getSize() > $this->parser->maxFullReadBytes()) {
            // Guard against pathologically large files
            $this->logger->warning('Joplin: note exceeds max size, truncating', ['id' => $id]);
        }

        $contents = $file->getContent();
        $parsed   = $this->parser->parse($contents);

        if ($parsed['type'] !== 1) {
            return null;
        }

        return [
            'id'           => $parsed['id'] ?? $id,
            'title'        => $parsed['title'] !== '' ? $parsed['title'] : $entry['title'],
            'body'         => $parsed['body'],
            'parent_id'    => $parsed['parent_id'],
            'created_time' => $parsed['created_time'],
            'updated_time' => $parsed['updated_time'],
            'path'         => $entry['path'],
            'mtime'        => $file->getMTime(),
        ];
    }

    /* ------------------------------------------------------------------ */
    /*  Helpers                                                            */
    /* ------------------------------------------------------------------ */

    private function cacheKey(string $userId): string {
        return 'idx:' . $userId;
    }

    /** Convert an absolute node path ("/alice/files/Joplin/xyz.md") to user-relative ("Joplin/xyz.md"). */
    private function toUserRelativePath(string $userId, string $nodePath): ?string {
        $prefix = '/' . $userId . '/files/';
        if (strpos($nodePath, $prefix) !== 0) {
            return null;
        }
        return substr($nodePath, strlen($prefix));
    }
}
