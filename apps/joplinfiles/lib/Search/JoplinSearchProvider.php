<?php
declare(strict_types=1);

namespace OCA\JoplinFiles\Search;

use OCP\App\IAppManager;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\IUser;
use OCP\Search\IProvider;
use OCP\Search\ISearchQuery;
use OCP\Search\SearchResult;
use OCP\Search\SearchResultEntry;

/**
 * Unified-search provider that finds Joplin notes by their *title*
 * (the first line inside the .md file) instead of their GUID filename.
 */
class JoplinSearchProvider implements IProvider {

    public function __construct(
        private IRootFolder $rootFolder,
        private IURLGenerator $urlGenerator,
        private IL10N $l10n,
        private IAppManager $appManager,
    ) {}

    public function getId(): string {
        return 'joplinfiles';
    }

    public function getName(): string {
        return $this->l10n->t('Joplin notes');
    }

    public function getOrder(string $route, array $routeParameters): int {
        // Show right after the Files provider
        return 6;
    }

    public function search(IUser $user, ISearchQuery $query): SearchResult {
        $term = trim($query->getTerm());
        if ($term === '' || mb_strlen($term) < 2) {
            return SearchResult::complete($this->getName(), []);
        }
        $needle = mb_strtolower($term);

        $userFolder = $this->rootFolder->getUserFolder($user->getUID());

        $entries = [];
        $remaining = max(5, $query->getLimit());

        foreach ($this->findJoplinFolders($userFolder) as $jf) {
            if ($remaining <= 0) break;
            foreach ($jf->getDirectoryListing() as $child) {
                if ($remaining <= 0) break;
                if (!($child instanceof File)) continue;

                $name = $child->getName();
                if (!preg_match('/^[0-9a-f]{32}\.md$/i', $name)) continue;

                $title = $this->extractTitle($child);
                if ($title === '' || mb_stripos($title, $needle) === false) {
                    continue;
                }

                $folderPath = $userFolder->getRelativePath($jf->getPath()) ?? '/';
                // NC33+ requires the `view` parameter for files.view.indexViewFileid.
                // Older NC versions ignore the extra param, so it's safe to always send it.
                $url = $this->urlGenerator->linkToRoute('files.view.indexViewFileid', [
                    'view'   => 'files',
                    'fileid' => $child->getId(),
                ]) . '?dir=' . rawurlencode($folderPath) . '&openfile=true';

                $entries[] = new SearchResultEntry(
                    '',                                           // thumbnail URL (none)
                    $title,                                       // title
                    ltrim($folderPath, '/') ?: $this->l10n->t('Joplin'), // subline
                    $url,
                    'icon-filetype-text'
                );
                $remaining--;
            }
        }

        return SearchResult::complete($this->getName(), $entries);
    }

    /**
     * Locate every Joplin sync folder beneath the user root by searching for
     * the canonical `version.txt` marker that lives inside `.sync/`.
     *
     * @return Folder[]
     */
    private function findJoplinFolders(Folder $userFolder): array {
        $found = [];
        try {
            $matches = $userFolder->search('version.txt');
        } catch (\Throwable $e) {
            return [];
        }
        foreach ($matches as $node) {
            if (!($node instanceof File)) continue;
            try {
                $sync = $node->getParent();
                if (!($sync instanceof Folder) || $sync->getName() !== '.sync') continue;
                $joplin = $sync->getParent();
                if ($joplin instanceof Folder) {
                    $found[$joplin->getPath()] = $joplin;
                }
            } catch (NotFoundException $e) {
                // skip
            }
        }
        return array_values($found);
    }

    /**
     * Read the first non-metadata, non-empty line of a Joplin note as its title.
     * Returns '' for revision/metadata-only files.
     */
    private function extractTitle(File $file): string {
        try {
            $stream = $file->fopen('r');
            if ($stream === false) return '';
        } catch (\Throwable $e) {
            return '';
        }
        $title = '';
        while (($line = fgets($stream)) !== false) {
            $trimmed = trim($line);
            if ($trimmed === '') continue;
            if ($title === '' && strncmp($trimmed, "\xEF\xBB\xBF", 3) === 0) {
                $trimmed = substr($trimmed, 3);
                if ($trimmed === '') continue;
            }
            if (preg_match('/^[a-z][a-z0-9_]*:\s/', $trimmed)) {
                $title = '';
                break;
            }
            $title = ltrim($trimmed, "# \t");
            break;
        }
        fclose($stream);
        return $title;
    }
}
