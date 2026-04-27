<?php
declare(strict_types=1);

namespace OCA\Joplin\Service;

/**
 * Parses a single Joplin .md file from a sync folder.
 *
 * Joplin sync format:
 *   Line 1         : note/folder title
 *   Line 2         : blank
 *   Body           : Markdown (for notes) — may be empty for folders
 *   Trailing block : "key: value" metadata lines (id, parent_id, type_, …)
 *
 * The metadata block is the contiguous run of "key: value" lines at the
 * very end of the file. `type_: 1` = note, `type_: 2` = folder (notebook).
 *
 * This parser is read-only and never mutates the source file.
 */
class JoplinParser {

    /** Maximum note size we will fully read into memory (bytes). */
    private const MAX_FULL_READ = 2 * 1024 * 1024;  // 2 MiB

    /** How many bytes to read from the file head for title extraction. */
    private const HEAD_BYTES = 2048;

    /** How many bytes to read from the tail when only metadata is needed. */
    private const TAIL_BYTES = 4096;

    /**
     * Parse full file contents.
     *
     * @return array{
     *     title: string,
     *     body: string,
     *     metadata: array<string,string>,
     *     type: int,
     *     id: ?string,
     *     parent_id: ?string,
     *     updated_time: ?string,
     *     created_time: ?string
     * }
     */
    public function parse(string $contents): array {
        // Normalise line endings
        $contents = str_replace(["\r\n", "\r"], "\n", $contents);

        // Split metadata block from head
        [$head, $metadata] = $this->splitMetadata($contents);

        // Extract title using the canonical 3-tier strategy:
        //   1. Joplin metadata `title:` field (rare but authoritative)
        //   2. First markdown heading (# / ## / ...)
        //   3. First non-empty line of the file
        $headLines = explode("\n", $head);
        $body = $head;
        $bodyStartIdx = 0;

        // Find first non-empty line index for body splitting
        foreach ($headLines as $i => $line) {
            if (trim($line) !== '') {
                $bodyStartIdx = $i + 1;
                break;
            }
        }
        // Skip a single blank separator line if present
        if (isset($headLines[$bodyStartIdx]) && trim($headLines[$bodyStartIdx]) === '') {
            $bodyStartIdx++;
        }
        $body = implode("\n", array_slice($headLines, $bodyStartIdx));
        $body = rtrim($body, "\n");

        $title = $this->extractTitle($head, $body, $metadata);

        $type = isset($metadata['type_']) ? (int) $metadata['type_'] : 0;

        return [
            'title'        => $title,
            'body'         => $body,
            'metadata'     => $metadata,
            'type'         => $type,
            'id'           => $metadata['id']           ?? null,
            'parent_id'    => ($metadata['parent_id']   ?? '') !== '' ? $metadata['parent_id']   : null,
            'updated_time' => $metadata['updated_time'] ?? null,
            'created_time' => $metadata['created_time'] ?? null,
        ];
    }

    /**
     * Lightweight metadata-only parse: reads just enough from the file tail to
     * extract id/parent_id/type_/updated_time/title.
     * Used when indexing large sync folders so we don't load full note bodies.
     *
     * $reader is a callable(int $offset, int $length): string|false — reads from the file.
     * $size is the file's total length in bytes.
     *
     * @return array{
     *     title: string,
     *     metadata: array<string,string>,
     *     type: int,
     *     id: ?string,
     *     parent_id: ?string,
     *     updated_time: ?string,
     *     created_time: ?string
     * }|null
     */
    public function parseHeader(callable $reader, int $size): ?array {
        if ($size <= 0) {
            return null;
        }

        // Read first HEAD_BYTES for title extraction (heading or first line)
        $headLen = min(self::HEAD_BYTES, $size);
        $head = $reader(0, $headLen);
        if ($head === false) {
            return null;
        }
        $head = str_replace(["\r\n", "\r"], "\n", $head);
        // Strip UTF-8 BOM if present
        if (strncmp($head, "\xEF\xBB\xBF", 3) === 0) {
            $head = substr($head, 3);
        }

        // Read last N bytes for the metadata block
        $tailLen = min(self::TAIL_BYTES, $size);
        $tail = $reader(max(0, $size - $tailLen), $tailLen);
        if ($tail === false) {
            $tail = '';
        }
        $tail = str_replace(["\r\n", "\r"], "\n", $tail);

        $metadata = $this->extractMetadataFromTail($tail);
        $type = isset($metadata['type_']) ? (int) $metadata['type_'] : 0;

        $title = $this->extractTitle($head, $head, $metadata);

        return [
            'title'        => $title,
            'metadata'     => $metadata,
            'type'         => $type,
            'id'           => $metadata['id']           ?? null,
            'parent_id'    => ($metadata['parent_id']   ?? '') !== '' ? $metadata['parent_id']   : null,
            'updated_time' => $metadata['updated_time'] ?? null,
            'created_time' => $metadata['created_time'] ?? null,
        ];
    }

    /**
     * Canonical title extraction. In order:
     *   1. Joplin metadata `title:` field (rarely set in sync files but honoured if present)
     *   2. First markdown heading (`# Title`, `## Title`, …) anywhere in the head region
     *   3. First non-empty line of the head region
     *
     * Returns '' only if absolutely nothing can be found — callers must NOT
     * fall back to filenames; let the UI render a "(untitled)" placeholder.
     *
     * @param array<string,string> $metadata
     */
    public function extractTitle(string $head, string $body, array $metadata): string {
        // 1. Explicit metadata title (some Joplin exports / plugins write this)
        if (!empty($metadata['title'])) {
            $t = trim($metadata['title']);
            if ($t !== '') {
                return $t;
            }
        }

        // 2. First markdown heading in the head region
        if (preg_match('/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m', $head, $m)) {
            $t = trim($m[1]);
            if ($t !== '') {
                return $t;
            }
        }
        // Heading inside body (used when head is just title region)
        if ($body !== $head && preg_match('/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m', $body, $m)) {
            $t = trim($m[1]);
            if ($t !== '') {
                return $t;
            }
        }

        // 3. First non-empty line
        foreach (explode("\n", $head) as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            // Strip leading "#" markers if the first line happened to be a heading
            $line = ltrim($line, "# \t");
            if ($line !== '') {
                return $line;
            }
        }

        return '';
    }

    public function maxFullReadBytes(): int {
        return self::MAX_FULL_READ;
    }

    /**
     * Split the file into [head-without-metadata, metadata-map].
     *
     * @return array{0:string,1:array<string,string>}
     */
    private function splitMetadata(string $contents): array {
        $lines = explode("\n", $contents);
        // Trim trailing blank lines
        while (!empty($lines) && trim(end($lines)) === '') {
            array_pop($lines);
        }

        // Walk backwards collecting contiguous "key: value" lines
        $metaLines = [];
        for ($i = count($lines) - 1; $i >= 0; $i--) {
            $line = $lines[$i];
            if ($this->isMetadataLine($line)) {
                $metaLines[] = $line;
                continue;
            }
            break;
        }

        // A metadata block must have at least a couple of recognised keys to count
        $metadata = $this->parseMetadataLines(array_reverse($metaLines));
        if (!$this->looksLikeJoplinMetadata($metadata)) {
            return [implode("\n", $lines), []];
        }

        $head = implode("\n", array_slice($lines, 0, count($lines) - count($metaLines)));
        $head = rtrim($head, "\n");
        return [$head, $metadata];
    }

    /** @return array<string,string> */
    private function extractMetadataFromTail(string $tail): array {
        $lines = explode("\n", $tail);
        while (!empty($lines) && trim(end($lines)) === '') {
            array_pop($lines);
        }
        $metaLines = [];
        for ($i = count($lines) - 1; $i >= 0; $i--) {
            if ($this->isMetadataLine($lines[$i])) {
                $metaLines[] = $lines[$i];
                continue;
            }
            break;
        }
        $meta = $this->parseMetadataLines(array_reverse($metaLines));
        return $this->looksLikeJoplinMetadata($meta) ? $meta : [];
    }

    private function isMetadataLine(string $line): bool {
        // Joplin metadata keys are lowercase ASCII with underscores, no spaces before the colon.
        return (bool) preg_match('/^[a-z][a-z0-9_]*:\s?.*$/', $line);
    }

    /** @param string[] $lines @return array<string,string> */
    private function parseMetadataLines(array $lines): array {
        $out = [];
        foreach ($lines as $line) {
            $pos = strpos($line, ':');
            if ($pos === false) {
                continue;
            }
            $key = substr($line, 0, $pos);
            $val = ltrim(substr($line, $pos + 1));
            $out[$key] = $val;
        }
        return $out;
    }

    /** @param array<string,string> $meta */
    private function looksLikeJoplinMetadata(array $meta): bool {
        return isset($meta['type_']) && isset($meta['id']);
    }
}
