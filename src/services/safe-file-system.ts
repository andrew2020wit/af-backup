// Safe file system operations: retries on Windows, complete writes, folder fsync
// (docs/spec.md, "Retries", "Writing to disk").

import { setTimeout as sleep } from 'node:timers/promises';
import { errorCode } from '../utilities/errors.js';
import { isWindows } from '../utilities/platform.js';
import { fileSystemOperations, type FileHandle } from './file-system-operations.js';

/**
 * Pauses between retries of deletions on Windows (antivirus, indexer, File Explorer
 * hold freshly written files): about 10 seconds in total. Tests shorten them.
 */
export const retrySettings = {
  delaysMilliseconds: [100, 200, 400, 800, 1500, 2000, 2500, 2500],
  /** Retries are needed on Windows only; tests may enable them elsewhere. */
  enabled: isWindows,
};

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Runs an operation, retrying it on transient Windows errors (EPERM, EACCES, EBUSY). */
export async function withRetries<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const delay = retrySettings.delaysMilliseconds[attempt];

      if (!retrySettings.enabled || delay === undefined || !TRANSIENT.has(errorCode(error) ?? '')) {
        throw error;
      }

      await sleep(delay);
    }
  }
}

/**
 * Writes all of `data`: a single write may write fewer bytes (for example, right at a file system limit),
 * the rest is written by further calls, which then report the actual error. `position` null - the current position.
 */
export async function writeAll(fileHandle: FileHandle, data: Buffer | string, position: number | null = null): Promise<void> {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let offset = 0;

  while (offset < buffer.length) {
    const { bytesWritten } = await fileHandle.write(buffer, offset, buffer.length - offset, position === null ? null : position + offset);

    if (bytesWritten <= 0) {
      throw Object.assign(new Error('EIO: no bytes were written'), { code: 'EIO' });
    }

    offset += bytesWritten;
  }
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fileSystemOperations.lstat(targetPath);

    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

/** Flushes a folder (its entries) to disk; not available on Windows - no-op there. */
export async function fsyncDirectory(directoryPath: string): Promise<void> {
  if (isWindows) {
    return;
  }

  const fileHandle = await fileSystemOperations.open(directoryPath, 'r');

  try {
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
}
