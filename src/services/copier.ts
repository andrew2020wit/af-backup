// Copying an uncompressed source (step 6; docs/spec.md, "What is copied", "Retries",
// "Files changing during copy", "Writing to disk").

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { FatalError, describeError, errorCode, fatalFrom, throwIfAborted } from '../utilities/errors.js';
import { classifyDestinationError, isAvailable } from './error-classification.js';
import { fileSystemOperations, type FileHandle } from './file-system-operations.js';
import { fsyncDirectory, withRetries, writeAll } from './safe-file-system.js';
import { escapeControl } from '../utilities/escape.js';
import { plural } from '../utilities/format.js';
import type { ListedEntry, SourceList } from './file-list.js';
import type { CopiedItems } from './copied-items.js';
import type { RunReport } from './run-report.js';

export const copySettings = {
  attempts: 3,
  retryPauseMilliseconds: 1000,
  chunkSize: 1024 * 1024,
};

export interface CopyProgress {
  files: number;
  bytes: number;
}

export interface CopyContext {
  backupRoot: string;
  copiedItems: CopiedItems;
  report: RunReport;
  signal: AbortSignal;
  progress: CopyProgress;
  onProgress: () => void;
  /** Throws FatalError if the log can no longer be written (level 2: the run stops at once). */
  checkLog: () => void;
}

/** A failure of one attempt for one item (level 3); `retry: false` - retrying is pointless. */
export class ItemError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
    /** A source read error: after it the availability of the source root is checked. */
    readonly sourceSide: boolean,
  ) {
    super(message);
  }
}

/** The source root became unavailable: copying (archiving) of this source stops. */
export class SourceUnavailable extends Error {}

/** Turns a destination error into FatalError (level 2) or ItemError (level 3, not retried). */
export async function destinationFailure(error: unknown, what: string, backupRoot: string): Promise<FatalError | ItemError> {
  if ((await classifyDestinationError(error, backupRoot)) === 'fatal') {
    return fatalFrom(what, error);
  }

  const code = errorCode(error);

  const reason =
    code === 'EEXIST'
      ? 'a file or folder with this name already exists in the backup (names that differ only in case on a case-insensitive disk?)'
      : code === 'EFBIG'
        ? 'the file is larger than the destination file system allows'
        : code === 'ENAMETOOLONG'
          ? 'the path is too long for the destination'
          : `cannot be created in the backup: ${describeError(error)}`;

  return new ItemError(code && !reason.includes(`(${code})`) ? `${reason} (${code})` : reason, false, false);
}

/** The folder whose availability tells whether the source is still connected. */
export function sourceRootFor(list: SourceList): string {
  return list.kind === 'file' ? path.dirname(list.source.path) : list.source.path;
}

/** Copies one source into `<backupRoot>/<name>/`. Throws FatalError (level 2) and InterruptedError. */
export async function copySource(list: SourceList, context: CopyContext): Promise<void> {
  if (list.kind === 'unusable') {
    return;
  }

  const name = list.source.name;
  const sourceDirectory = path.join(context.backupRoot, name);

  try {
    await fileSystemOperations.mkdir(sourceDirectory);
  } catch (error) {
    const failure = await destinationFailure(error, `cannot create folder ${name} in the backup`, context.backupRoot);

    if (failure instanceof FatalError) {
      throw failure;
    }

    context.report.error(`${escapeControl(name)}/: ${failure.message}; the source is not copied (${plural(list.files, 'file')})`);

    return;
  }

  context.copiedItems.addDirectory({ type: 'dir', path: name });

  // POSIX: a folder is flushed after all its items have been created (a stack during the depth-first walk)
  const created: { relativePath: string; absolutePath: string }[] = [{ relativePath: '', absolutePath: sourceDirectory }];

  const flushUntil = async (relativePath: string | null) => {
    while (created.length) {
      const top = created[created.length - 1]!;

      if (relativePath !== null && (top.relativePath === '' || relativePath.startsWith(`${top.relativePath}/`))) {
        return;
      }

      created.pop();

      try {
        await fsyncDirectory(top.absolutePath);
      } catch (error) {
        throw fatalFrom(`cannot flush folder ${name}/${top.relativePath} to disk`, error);
      }
    }
  };

  const sourceRoot = sourceRootFor(list);
  let skipPrefix: string | null = null;
  const entries = list.entries;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    throwIfAborted(context.signal);
    context.checkLog();

    if (skipPrefix !== null && entry.relativePath.startsWith(skipPrefix)) {
      continue;
    }

    skipPrefix = null;
    await flushUntil(entry.relativePath);
    const shown = escapeControl(`${name}/${entry.relativePath}`);
    const target = path.join(sourceDirectory, ...entry.relativePath.split('/'));

    if (entry.type === 'dir') {
      try {
        await fileSystemOperations.mkdir(target);
      } catch (error) {
        const failure = await destinationFailure(error, `cannot create folder ${shown}`, context.backupRoot);

        if (failure instanceof FatalError) {
          throw failure;
        }

        const inside = entries.filter((other) => other.relativePath.startsWith(`${entry.relativePath}/`)).length;
        context.report.error(`${shown}/: ${failure.message}; its content is skipped (${plural(inside, 'item')})`);
        skipPrefix = `${entry.relativePath}/`;
        continue;
      }

      context.copiedItems.addDirectory({ type: 'dir', path: `${name}/${entry.relativePath}` });
      created.push({ relativePath: entry.relativePath, absolutePath: target });
      continue;
    }

    const backupPath = `${name}/${entry.relativePath}`;

    try {
      await withFileRetries(shown, sourceRoot, context, async () => {
        const readResult = await copyOnce(entry, target, backupPath, shown, context);

        context.copiedItems.addFile({ type: 'file', path: backupPath, size: readResult.size, sha256: readResult.sha256 });
      });
    } catch (error) {
      if (!(error instanceof SourceUnavailable)) {
        throw error;
      }

      const left = entries.slice(i).filter((other) => other.type === 'file').length;
      context.report.error(`source "${name}" (${list.source.path}) became unavailable: ${error.message}; ${plural(left, 'file')} not copied`);
      break;
    }
  }

  await flushUntil(null);
}

/**
 * Runs one file attempt up to 3 times (docs/spec.md, "Retries"); after the last failure - a level 3 error.
 * After a source read error the source root is checked: unavailable - SourceUnavailable.
 */
export async function withFileRetries(shown: string, sourceRoot: string, context: CopyContext, attempt: () => Promise<void>): Promise<void> {
  let lastError = '';

  for (let attemptNumber = 1; attemptNumber <= copySettings.attempts; attemptNumber++) {
    if (attemptNumber > 1) {
      try {
        await sleep(copySettings.retryPauseMilliseconds, undefined, { signal: context.signal });
      } catch (error) {
        throwIfAborted(context.signal);
        throw error;
      }
    }

    try {
      await attempt();
      context.progress.files++;
      context.onProgress();

      return;
    } catch (error) {
      if (!(error instanceof ItemError)) {
        throw error;
      }

      lastError = error.message;

      if (error.sourceSide && !(await isAvailable(sourceRoot))) {
        throw new SourceUnavailable(error.message);
      }

      if (!error.retry) {
        context.report.error(`${shown}: ${lastError}`);

        return;
      }
    }
  }

  context.report.error(`${shown}: ${lastError}, ${copySettings.attempts} attempts`);
}

function readFailure(error: unknown, what: string): ItemError {
  const code = errorCode(error);

  if (code === 'ENOENT') {
    return new ItemError('the file disappeared during the run (ENOENT)', false, true);
  }

  if (code === 'EBUSY') {
    return new ItemError('the file is locked (EBUSY)', true, true);
  }

  if (code === 'EPERM' || code === 'EACCES') {
    return new ItemError(`no permission to read the file, or it is locked (${code})`, true, true);
  }

  return new ItemError(`${what}: ${describeError(error)}`, true, true);
}

export interface ReadResult {
  size: number;
  mtimeNs: bigint;
  sha256: string;
}

/**
 * Reads a source file chunk by chunk, hashing it and passing each chunk to `write`.
 * The size and modification time are compared before and after; a change - a retriable ItemError.
 */
export async function readSourceFile(
  entry: ListedEntry,
  signal: AbortSignal,
  sink: { begin: (size: number, mtimeNs: bigint) => Promise<void>; write: (chunk: Buffer) => Promise<void> },
): Promise<ReadResult> {
  let before;

  try {
    before = await fileSystemOperations.stat(entry.absolutePath);
  } catch (error) {
    throw readFailure(error, 'cannot read the file information');
  }

  if (!before.isFile()) {
    throw new ItemError('the item is no longer a regular file', false, false);
  }

  let sourceHandle: FileHandle;

  try {
    sourceHandle = await fileSystemOperations.open(entry.absolutePath, 'r');
  } catch (error) {
    throw readFailure(error, 'cannot open the file');
  }

  try {
    await sink.begin(Number(before.size), before.mtimeNs);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(copySettings.chunkSize);
    let size = 0;

    while (true) {
      throwIfAborted(signal);
      let bytesRead: number;

      try {
        ({ bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null));
      } catch (error) {
        throw readFailure(error, 'read error');
      }

      if (bytesRead === 0) {
        break;
      }

      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await sink.write(chunk);
      size += bytesRead;
    }

    let after;

    try {
      after = await fileSystemOperations.stat(entry.absolutePath);
    } catch (error) {
      throw readFailure(error, 'cannot read the file information');
    }

    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || BigInt(size) !== after.size) {
      throw new ItemError('the file changed while being copied', true, false);
    }

    return { size, mtimeNs: before.mtimeNs, sha256: hash.digest('hex') };
  } finally {
    await sourceHandle.close().catch(() => {});
  }
}

/** @param backupPath the path of the file in the backup data folder, separator "/" */
async function copyOnce(entry: ListedEntry, target: string, backupPath: string, shown: string, context: CopyContext): Promise<ReadResult> {
  // assigned in `begin`; `as` keeps TypeScript from treating it as always null
  let targetHandle = null as FileHandle | null;
  let complete = false;
  let written = 0;

  try {
    const readResult = await readSourceFile(entry, context.signal, {
      // the target is created after the source has been opened
      begin: async () => {
        try {
          targetHandle = await fileSystemOperations.open(target, 'wx');
        } catch (error) {
          throw await destinationFailure(error, 'cannot create the file in the backup', context.backupRoot);
        }
      },
      write: async (chunk) => {
        try {
          await writeAll(targetHandle!, chunk);
        } catch (error) {
          throw await destinationFailure(error, 'write error in the backup', context.backupRoot);
        }

        written += chunk.length;
        context.progress.bytes += chunk.length;
        context.onProgress();
      },
    });

    if (!targetHandle) {
      throw new Error('internal error: the target file was not created');
    }

    // seconds as a number, not a Date: a Date would cut the time to milliseconds; whole microseconds are exact
    // in a double, and the fraction keeps sub-microsecond precision
    const mtime = Number(readResult.mtimeNs / 1000n) / 1_000_000;

    try {
      await targetHandle.utimes(mtime, mtime);
    } catch (error) {
      context.report.warn(`${shown}: could not set the modification time: ${describeError(error)}`);
    }

    try {
      await targetHandle.sync();
    } catch (error) {
      throw fatalFrom('cannot flush a file to disk', error);
    }

    complete = true;

    try {
      await targetHandle.close();
    } catch (error) {
      throw fatalFrom('cannot close a file in the backup', error);
    }

    return readResult;
  } catch (error) {
    if (complete) {
      throw error;
    }

    context.progress.bytes -= written;

    if (!targetHandle) {
      throw error;
    }

    await targetHandle.close().catch(() => {});
    const removed = await removeUnfinished(target, backupPath, shown, context);

    // a retry would only run into the leftover file ("new only" mode)
    if (!removed && error instanceof ItemError && error.retry) {
      throw new ItemError(`${error.message}; the unfinished file could not be deleted, so there are no more attempts`, false, error.sourceSide);
    }

    throw error;
  }
}

/** Deletes our own unfinished file; false - it stays (a warning is written, verification will report it as extra). */
async function removeUnfinished(target: string, backupPath: string, shown: string, context: CopyContext): Promise<boolean> {
  try {
    await withRetries(() => fileSystemOperations.unlink(target));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      context.report.warn(`${shown}: could not delete the unfinished file (verification will show it as extra): ${describeError(error)}`);
      context.copiedItems.leftovers.add(backupPath);

      return false;
    }
  }

  return true;
}
