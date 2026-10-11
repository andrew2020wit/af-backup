// Classification of destination write errors (docs/spec.md, "Error handling"):
// level 2 (the destination as a whole) or level 3 (this item only).

import { errorCode } from '../utilities/errors.js';
import { fileSystemOperations } from './file-system-operations.js';

const FATAL = new Set(['ENOSPC', 'EIO', 'EROFS', 'EDQUOT', 'ENODEV', 'ENXIO', 'ESTALE', 'ENOTCONN', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETDOWN', 'ENETUNREACH', 'ECONNRESET', 'ENOMEM']);
const ITEM = new Set(['ENAMETOOLONG', 'EINVAL', 'EEXIST', 'EFBIG', 'EILSEQ', 'EISDIR']);

export type DestinationErrorLevel = 'fatal' | 'item';

/**
 * @param backupRoot the backup folder being written: for an ambiguous error (ENOENT, EACCES, EPERM, UNKNOWN…)
 *   its availability decides - unavailable means the destination as a whole failed.
 */
export async function classifyDestinationError(error: unknown, backupRoot: string): Promise<DestinationErrorLevel> {
  const code = errorCode(error) ?? '';

  if (FATAL.has(code)) {
    return 'fatal';
  }

  if (ITEM.has(code)) {
    return 'item';
  }

  try {
    const stats = await fileSystemOperations.stat(backupRoot);

    return stats.isDirectory() ? 'item' : 'fatal';
  } catch {
    return 'fatal';
  }
}

/** Whether a source root (folder or file) is still available after a read error. */
export async function isAvailable(targetPath: string): Promise<boolean> {
  try {
    await fileSystemOperations.stat(targetPath);

    return true;
  } catch {
    return false;
  }
}
