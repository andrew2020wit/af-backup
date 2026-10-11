// Building the file list (step 4 of "Task execution"; docs/spec.md, "Exclusions", "What is copied").
//
// Exclusions are checked first: an excluded item is not even examined. The item type is determined
// before opening (reading a FIFO may hang forever). Links inside a source are not followed.

import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { describeError, errorCode, throwIfAborted } from '../utilities/errors.js';
import { fileSystemOperations } from './file-system-operations.js';
import { escapeBytes, escapeControl } from '../utilities/escape.js';
import { caseInsensitiveNames } from '../utilities/platform.js';
import { compileMask, type CompiledMask } from './masks.js';
import type { ValidatedSource, ValidatedTask } from './task-validator.js';
import type { RunReport } from './run-report.js';

export interface ListedEntry {
  type: 'dir' | 'file';
  /** Path from the source root with "/"; for a file source - the file name. */
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeNs: bigint;
}

export interface SourceList {
  source: ValidatedSource;
  /** What the source path is: a folder, a file, or unusable (missing, empty, unreadable - a level 3 error was recorded). */
  kind: 'dir' | 'file' | 'unusable';
  /** Folders come before their content, names in code point order. */
  entries: ListedEntry[];
  files: number;
  bytes: number;
  excluded: number;
  /** Device of the source (for the "same disk" check). */
  dev: bigint | null;
}

export interface MaskCounter {
  label: string;
  mask: CompiledMask;
  count: number;
}

export interface FileList {
  sources: SourceList[];
  /** Match counters: task masks first, then per-source masks labelled "<source>/<mask>". */
  masks: MaskCounter[];
  totalFiles: number;
  totalBytes: number;
}

// ignoreBOM: a name may start with U+FEFF, it must not be dropped
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** For matching masks against a name that is not in UTF-8: invalid bytes become U+FFFD. */
const lossyTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

function specialKind(stats: { isFIFO(): boolean; isSocket(): boolean; isBlockDevice(): boolean; isCharacterDevice(): boolean }): string {
  if (stats.isFIFO()) {
    return 'FIFO';
  }

  if (stats.isSocket()) {
    return 'socket';
  }

  if (stats.isBlockDevice()) {
    return 'block device';
  }

  if (stats.isCharacterDevice()) {
    return 'character device';
  }

  return 'unknown type';
}

export async function buildFileList(
  task: ValidatedTask,
  report: RunReport,
  signal?: AbortSignal,
  caseInsensitive = caseInsensitiveNames,
): Promise<FileList> {
  const taskMasks: MaskCounter[] = task.exclude.map((mask) => ({ label: mask, mask: compileMask(mask, caseInsensitive), count: 0 }));
  const masks = [...taskMasks];
  const sources: SourceList[] = [];

  for (const source of task.sources) {
    const ownMasks = source.exclude.map((mask) => ({ label: `${source.name}/${mask}`, mask: compileMask(mask, caseInsensitive), count: 0 }));
    masks.push(...ownMasks);
    sources.push(await listSource(source, [...taskMasks, ...ownMasks], report, signal));
  }

  return {
    sources,
    masks,
    totalFiles: sources.reduce((total, sourceList) => total + sourceList.files, 0),
    totalBytes: sources.reduce((total, sourceList) => total + sourceList.bytes, 0),
  };
}

async function listSource(source: ValidatedSource, masks: MaskCounter[], report: RunReport, signal?: AbortSignal): Promise<SourceList> {
  const list: SourceList = { source, kind: 'unusable', entries: [], files: 0, bytes: 0, excluded: 0, dev: null };
  const label = `source "${source.name}" (${source.path})`;
  let stats;

  try {
    stats = await fileSystemOperations.stat(source.path); // the source itself may be a link: it is followed
  } catch (error) {
    const code = errorCode(error);

    report.error(
      code === 'ENOENT' || code === 'ENOTDIR'
        ? `${label} does not exist (${code}) - the disk may not be connected`
        : `${label} is unavailable: ${describeError(error)}`,
    );

    return list;
  }

  list.dev = stats.dev;

  if (stats.isFile()) {
    list.kind = 'file';
    list.entries.push({ type: 'file', relativePath: path.basename(source.path), absolutePath: source.path, size: Number(stats.size), mtimeNs: stats.mtimeNs });
    list.files = 1;
    list.bytes = Number(stats.size);

    return list;
  }

  if (!stats.isDirectory()) {
    report.error(`${label} is not a file or a folder (${specialKind(stats)})`);

    return list;
  }

  let directoryEntries;

  try {
    directoryEntries = await fileSystemOperations.readdirBuffer(source.path);
  } catch (error) {
    report.error(`${label}: cannot read the folder: ${describeError(error)}`);

    return list;
  }

  if (directoryEntries.length === 0) {
    report.error(`${label} is empty - the disk may not be connected (if the source is really empty, remove it from the task)`);

    return list;
  }

  list.kind = 'dir';
  await walk(source.path, '', directoryEntries, list, masks, report, signal);

  return list;
}

interface Child {
  name: string;
  /** The name in UTF-8: comparing the bytes gives code point order (comparing strings gives UTF-16 order). */
  raw: Buffer;
}

async function walk(
  absoluteDirectory: string,
  relativeDirectory: string,
  directoryEntries: Dirent<Buffer>[],
  list: SourceList,
  masks: MaskCounter[],
  report: RunReport,
  signal?: AbortSignal,
): Promise<void> {
  const shown = (relativePath: string) => escapeControl(`${list.source.name}/${relativePath}`);
  const children: Child[] = [];

  for (const directoryEntry of directoryEntries) {
    const raw = directoryEntry.name;
    let name: string;

    try {
      name = textDecoder.decode(raw);
    } catch {
      // exclusions come first: an excluded item is not an error even if its name is not in UTF-8
      const lossyName = lossyTextDecoder.decode(raw);

      if (isExcluded(relativeDirectory ? `${relativeDirectory}/${lossyName}` : lossyName, lossyName, masks, list)) {
        continue;
      }

      const relativePath = relativeDirectory ? `${escapeControl(relativeDirectory)}/${escapeBytes(raw)}` : escapeBytes(raw);
      report.error(`${escapeControl(list.source.name)}/${relativePath}: file name is not in UTF-8 encoding - skipped${directoryEntry.isDirectory() ? ' with all its content' : ''}`);
      continue;
    }

    children.push({ name, raw });
  }

  children.sort((first, second) => Buffer.compare(first.raw, second.raw));

  for (const child of children) {
    throwIfAborted(signal);
    const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
    const absolutePath = path.join(absoluteDirectory, child.name);

    if (isExcluded(relativePath, child.name, masks, list)) {
      continue;
    }

    let stats;

    try {
      stats = await fileSystemOperations.lstat(absolutePath);
    } catch (error) {
      report.error(`${shown(relativePath)}: cannot read item information: ${describeError(error)}`);
      continue;
    }

    if (stats.isSymbolicLink()) {
      let target = '?';

      try {
        target = await fileSystemOperations.readlink(absolutePath);
      } catch {
        // the target is only informational
      }

      report.warn(`Skipped link: ${shown(relativePath)} -> ${escapeControl(target)}`);
      continue;
    }

    if (stats.isDirectory()) {
      list.entries.push({ type: 'dir', relativePath, absolutePath, size: 0, mtimeNs: stats.mtimeNs });
      let innerEntries;

      try {
        innerEntries = await fileSystemOperations.readdirBuffer(absolutePath);
      } catch (error) {
        report.error(`${shown(relativePath)}: cannot read the folder, its content is skipped: ${describeError(error)}`);
        continue;
      }

      await walk(absolutePath, relativePath, innerEntries, list, masks, report, signal);
      continue;
    }

    if (stats.isFile()) {
      const size = Number(stats.size);
      list.entries.push({ type: 'file', relativePath, absolutePath, size, mtimeNs: stats.mtimeNs });
      list.files++;
      list.bytes += size;
      continue;
    }

    report.warn(`Skipped special file (${specialKind(stats)}): ${shown(relativePath)}`);
  }
}

/**
 * Whether an item is excluded. It is counted by every mask that matches it, so a zero always means "matched nothing";
 * `excluded` of the source counts items, not matches (docs/spec.md, "Exclusions" → "Transparency").
 */
function isExcluded(relativePath: string, name: string, masks: MaskCounter[], list: SourceList): boolean {
  let matched = false;

  for (const maskCounter of masks) {
    if (maskCounter.mask.matches(relativePath, name)) {
      maskCounter.count++;
      matched = true;
    }
  }

  if (matched) {
    list.excluded++;
  }

  return matched;
}

/** Per-mask summary: "node_modules: 5, *.tmp: 0". */
export function maskSummary(masks: MaskCounter[]): string {
  return masks.map((maskCounter) => `${maskCounter.label}: ${maskCounter.count}`).join(', ');
}
