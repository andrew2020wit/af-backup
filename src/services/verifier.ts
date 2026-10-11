// Backup folder verification (step 7 of "Task execution"; docs/spec.md, "Verification"): the folder is compared
// with the list of copied items kept in memory. Does not stop at the first mismatch: all problems are collected.

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describeError, throwIfAborted } from '../utilities/errors.js';
import { fileSystemOperations } from './file-system-operations.js';
import type { CopiedArchive, CopiedDirectory, CopiedFile, CopiedItem } from '../interfaces/copied-item.interface.js';
import { escapeControl } from '../utilities/escape.js';
import { scanTarGz } from './tar-reader.js';

export interface VerifyProgress {
  files: number;
  bytes: number;
}

export interface VerifyOptions {
  signal: AbortSignal;
  progress: VerifyProgress;
  onProgress: () => void;
}

export interface VerifyResult {
  /** Mismatches of files and folders. */
  problems: string[];
  /** How many of the problems are unfinished files that could not be deleted: not a sign of a faulty disk. */
  leftovers: number;
}

interface DiskItem {
  type: 'dir' | 'file' | 'other';
}

async function walkDisk(root: string, signal: AbortSignal): Promise<Map<string, DiskItem>> {
  const items = new Map<string, DiskItem>();

  const visit = async (absolutePath: string, relativePath: string) => {
    for (const name of await fileSystemOperations.readdir(absolutePath)) {
      throwIfAborted(signal);
      const childRelativePath = relativePath ? `${relativePath}/${name}` : name;
      const stats = await fileSystemOperations.lstat(path.join(absolutePath, name));
      const type = stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other';
      items.set(childRelativePath, { type });

      if (type === 'dir') {
        await visit(path.join(absolutePath, name), childRelativePath);
      }
    }
  };

  await visit(root, '');

  return items;
}

export async function sha256OfFile(
  filePath: string,
  signal: AbortSignal,
  onBytes?: (byteCount: number) => void,
): Promise<{ size: number; sha256: string }> {
  const fileHandle = await fileSystemOperations.open(filePath, 'r');

  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;

    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, null);

      if (bytesRead === 0) {
        break;
      }

      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
      onBytes?.(bytesRead);
    }

    return { size, sha256: hash.digest('hex') };
  } finally {
    await fileHandle.close();
  }
}

/** @param leftovers unfinished files that could not be deleted while copying (paths in the folder, separator "/") */
export async function verifyBackupFolder(
  folderPath: string,
  copiedItems: readonly CopiedItem[],
  leftovers: ReadonlySet<string>,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const result: VerifyResult = { problems: [], leftovers: 0 };

  // on disk: items without `in`, and archives; archive content - by items with `in`
  const onDisk = new Map<string, CopiedItem>();
  const archiveContent = new Map<string, (CopiedDirectory | CopiedFile)[]>();

  for (const item of copiedItems) {
    if ((item.type === 'dir' || item.type === 'file') && item.in !== undefined) {
      const list = archiveContent.get(item.in) ?? [];
      list.push(item);
      archiveContent.set(item.in, list);
    } else {
      onDisk.set(item.path, item);
    }
  }

  let disk: Map<string, DiskItem>;

  try {
    disk = await walkDisk(folderPath, options.signal);
  } catch (error) {
    throwIfAborted(options.signal);
    result.problems.push(`cannot read the backup folder: ${describeError(error)}`);

    return result;
  }

  for (const [relativePath, record] of onDisk) {
    const shown = escapeControl(relativePath);
    const item = disk.get(relativePath);
    disk.delete(relativePath);

    // already reported as a level 3 error while copying; not a sign of a faulty disk
    if (record.type === 'incomplete-archive') {
      continue;
    }

    if (record.type === 'dir') {
      if (!item) {
        result.problems.push(`missing folder: ${shown}`);
      } else if (item.type !== 'dir') {
        result.problems.push(`expected a folder, found a file: ${shown}`);
      }

      continue;
    }

    // the content of an archive belongs to its record even if the archive itself is missing on disk
    let content: (CopiedDirectory | CopiedFile)[] = [];

    if (record.type === 'archive') {
      content = archiveContent.get(record.path) ?? [];
      archiveContent.delete(record.path);
    }

    if (!item) {
      result.problems.push(`missing file: ${shown}`);
      continue;
    }

    if (item.type !== 'file') {
      result.problems.push(`expected a file, found ${item.type === 'dir' ? 'a folder' : 'another item'}: ${shown}`);
      continue;
    }

    const absolutePath = path.join(folderPath, ...relativePath.split('/'));

    if (record.type === 'archive') {
      await verifyArchive(absolutePath, record, content, result, options);
      continue;
    }

    await checkFile(absolutePath, record, shown, result, options);

    options.progress.files++;
    options.onProgress();
  }

  for (const [relativePath, item] of disk) {
    if (item.type === 'file' && leftovers.has(relativePath)) {
      result.problems.push(`extra file: ${escapeControl(relativePath)} - an unfinished file that could not be deleted (see the warning above)`);
      result.leftovers++;
      continue;
    }

    result.problems.push(`extra ${item.type === 'dir' ? 'folder' : 'file'}: ${escapeControl(relativePath)}`);
  }

  return result;
}

/** Checks an archive: its own SHA-256, complete extraction in memory, entries against the list of archived items. */
async function verifyArchive(
  absolutePath: string,
  record: CopiedArchive,
  content: (CopiedDirectory | CopiedFile)[],
  result: VerifyResult,
  options: VerifyOptions,
): Promise<void> {
  const shown = escapeControl(record.path);
  let scan;

  try {
    scan = await scanTarGz(absolutePath, options.signal, (byteCount) => {
      options.progress.bytes += byteCount;
      options.onProgress();
    });
  } catch (error) {
    throwIfAborted(options.signal);
    result.problems.push(`cannot read ${shown}: ${describeError(error)}`);

    return;
  }

  if (scan.fileSize !== record.size) {
    result.problems.push(`size ${scan.fileSize} instead of ${record.size}: ${shown}`);
  } else if (scan.fileSha256 !== record.sha256) {
    result.problems.push(`content does not match (SHA-256): ${shown}`);
  }

  for (const problem of scan.problems) {
    result.problems.push(`${shown}: ${problem}`);
  }

  if (!scan.ended && scan.problems.length === 0) {
    result.problems.push(`${shown}: the archive has no tar end (incomplete)`);
  }

  const expected = new Map(content.map((contentRecord) => [contentRecord.path, contentRecord]));
  const seen = new Set<string>();

  for (const entry of scan.entries) {
    const inside = `${shown}/${escapeControl(entry.path)}`;

    if (seen.has(entry.path)) {
      result.problems.push(`duplicate entry in the archive: ${inside}`);
      continue;
    }

    seen.add(entry.path);
    const expectedRecord = expected.get(entry.path);
    expected.delete(entry.path);

    if (!expectedRecord) {
      result.problems.push(`extra entry in the archive: ${inside}`);
      continue;
    }

    if (expectedRecord.type === 'dir') {
      if (entry.type !== 'dir') {
        result.problems.push(`expected a folder in the archive, found a file: ${inside}`);
      }

      continue;
    }

    if (entry.type !== 'file') {
      result.problems.push(`expected a file in the archive, found ${entry.type === 'dir' ? 'a folder' : 'another entry type'}: ${inside}`);
      continue;
    }

    if (entry.sha256 === undefined) {
      continue; // cut off - already reported
    }

    if (entry.size !== expectedRecord.size) {
      result.problems.push(`size ${entry.size} instead of ${expectedRecord.size}: ${inside}`);
    } else if (entry.sha256 !== expectedRecord.sha256) {
      result.problems.push(`content does not match (SHA-256): ${inside}`);
    }

    options.progress.files++;
  }

  // after corruption standard tools cannot reach the rest - it is reported once above
  const missing = [...expected.keys()];

  if (missing.length && scan.problems.length === 0) {
    for (const missingPath of missing) {
      result.problems.push(`missing in the archive: ${shown}/${escapeControl(missingPath)}`);
    }
  } else if (missing.length) {
    result.problems.push(`${shown}: ${missing.length} archived entries were not reached`);
  }
}

async function checkFile(
  absolutePath: string,
  record: CopiedFile | CopiedArchive,
  shown: string,
  result: VerifyResult,
  options: VerifyOptions,
): Promise<void> {
  try {
    const fileHash = await sha256OfFile(absolutePath, options.signal, (byteCount) => {
      options.progress.bytes += byteCount;
      options.onProgress();
    });

    if (fileHash.size !== record.size) {
      result.problems.push(`size ${fileHash.size} instead of ${record.size}: ${shown}`);
    } else if (fileHash.sha256 !== record.sha256) {
      result.problems.push(`content does not match (SHA-256): ${shown}`);
    }
  } catch (error) {
    throwIfAborted(options.signal);
    result.problems.push(`cannot read ${shown}: ${describeError(error)}`);
  }
}
