// The list of copied items with their SHA-256, kept in memory until verification (docs/spec.md,
// "Task execution", step 6); nothing of it is written to the backup folder.

import type { CopiedArchive, CopiedDirectory, CopiedFile, CopiedItem } from '../interfaces/copied-item.interface.js';

export class CopiedItems {
  items: CopiedItem[] = [];
  files = 0;
  directories = 0;
  /** Uncompressed size of the copied files. */
  bytes = 0;
  /**
   * Unfinished files that could not be deleted (a warning was written): verification reports them as extra,
   * but not as a sign of a faulty disk. Paths as in the items, separator "/".
   */
  readonly leftovers = new Set<string>();

  addDirectory(item: CopiedDirectory): void {
    this.directories++;
    this.items.push(item);
  }

  addFile(item: CopiedFile): void {
    this.files++;
    this.bytes += item.size;
    this.items.push(item);
  }

  addArchive(item: CopiedArchive): void {
    this.items.push(item);
  }

  /**
   * The tar end of the archive did not fit (EFBIG): its content is no longer counted as copied,
   * and verification only knows that the archive exists (docs/spec.md, "Compression" → "Errors and retries").
   */
  addIncompleteArchive(archiveName: string): void {
    const kept: CopiedItem[] = [];

    for (const item of this.items) {
      if (item.type === 'archive' || item.type === 'incomplete-archive' || item.in !== archiveName) {
        kept.push(item);
      } else if (item.type === 'dir') {
        this.directories--;
      } else {
        this.files--;
        this.bytes -= item.size;
      }
    }

    kept.push({ type: 'incomplete-archive', path: archiveName });
    this.items = kept;
  }
}
