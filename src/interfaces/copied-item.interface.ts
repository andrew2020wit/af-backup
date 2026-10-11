// Items copied by a run, kept in memory for verification (docs/spec.md, "Task execution", step 6).
// Paths are relative to the backup folder root (with the source subfolder), the separator is `/`;
// for the content of a compressed source - relative to the archive root, with `in` - the archive name.

export interface CopiedDirectory {
  type: 'dir';
  /** Archive name for a folder inside a compressed source. */
  in?: string;
  path: string;
}

export interface CopiedFile {
  type: 'file';
  in?: string;
  path: string;
  size: number;
  /** SHA-256 of the (uncompressed) content, lowercase hex. */
  sha256: string;
}

export interface CopiedArchive {
  type: 'archive';
  path: string;
  size: number;
  sha256: string;
}

/**
 * An archive whose tar end did not fit into the destination file system limit (EFBIG): the level 3 error has been
 * reported, its content is not counted as copied, and verification does not check it.
 */
export interface CopiedIncompleteArchive {
  type: 'incomplete-archive';
  path: string;
}

export type CopiedItem = CopiedDirectory | CopiedFile | CopiedArchive | CopiedIncompleteArchive;
