// Destination folder: it exists and holds no backup with the start time of this run yet - nothing named
// `backup-data-<start time>` or `backup-<start time>.log` (docs/spec.md, "Destination folder").

import { StartError, describeError, errorCode } from '../utilities/errors.js';
import type { BackupNames } from '../utilities/destination-layout.js';
import { fileSystemOperations } from './file-system-operations.js';
import { pathExists } from './safe-file-system.js';

/**
 * Level 1 error unless the destination folder exists and holds neither the backup data folder nor the log
 * of this run. Backups with other start times do not matter. Without `names` (--compute-size, nothing is created)
 * only the folder itself is checked.
 */
export async function checkDestination(destinationFolder: string, names?: BackupNames): Promise<void> {
  let stats;

  try {
    stats = await fileSystemOperations.stat(destinationFolder);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
      throw new StartError(`the destination folder does not exist: ${destinationFolder} - the disk may not be connected (af-backup does not create it)`);
    }

    throw new StartError(`the destination folder is unavailable: ${destinationFolder}: ${describeError(error)}`);
  }

  if (!stats.isDirectory()) {
    throw new StartError(`the destination is not a folder: ${destinationFolder}`);
  }

  if (!names) {
    return;
  }

  const existing: string[] = [];

  for (const [name, targetPath] of [
    [names.dataFolderName, names.dataFolder],
    [names.logFileName, names.logFile],
  ] as const) {
    try {
      if (await pathExists(targetPath)) {
        existing.push(name);
      }
    } catch (error) {
      throw new StartError(`cannot check ${targetPath}: ${describeError(error)}`);
    }
  }

  if (existing.length) {
    throw new StartError(
      `the destination folder already holds a backup with the same start time (${existing.join(', ')}): ${destinationFolder} - ` +
        'run again (nothing is overwritten)',
    );
  }
}
