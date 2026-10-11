// Steps 1-4 of "Task execution" (docs/spec.md): checks before anything is created in the destination folder -
// the destination folder, the task, overlapping paths, the file list, same disk, free space ("Safeguards").
// Also the whole of --compute-size ("Computing the size"). Nothing is changed on disk here.

import * as path from 'node:path';
import { StartError, describeError } from '../utilities/errors.js';
import { formatBytes } from '../utilities/format.js';
import { isSameOrInside } from '../utilities/platform.js';
import { fileSystemOperations } from './file-system-operations.js';
import { loadTask } from './task-loader.js';
import type { ValidatedTask } from './task-validator.js';
import { checkDestination } from './destination.js';
import type { BackupNames } from '../utilities/destination-layout.js';
import { buildFileList, type FileList, type SourceList } from './file-list.js';
import type { RunReport } from './run-report.js';

/** Free space margin: 1% of the total, but at least this (docs/spec.md, "Free space"). */
const MINIMUM_MARGIN = 100 * 1024 * 1024;

export interface PrepareOptions {
  /** Absolute path of the destination folder. */
  destinationFolder: string;
  /**
   * The backup data folder and the log of this run (named by its start time): the destination folder must not hold them.
   * Absent for --compute-size: nothing is created, so there is nothing to collide with.
   */
  backupNames?: BackupNames;
  report: RunReport;
  signal: AbortSignal;
}

/** Space in the destination folder: required for the backup (rounded up to blocks, with the margin) and available. */
export interface SpaceEstimate {
  required: number;
  available: number;
}

export interface Prepared {
  task: ValidatedTask;
  list: FileList;
  /** null if the free space cannot be determined (a warning has been reported). */
  space: SpaceEstimate | null;
}

export async function prepareRun(options: PrepareOptions): Promise<Prepared> {
  const { destinationFolder, backupNames, report, signal } = options;
  // Step 1: the destination folder exists and holds no backup with this start time yet
  await checkDestination(destinationFolder, backupNames);
  // Step 2: the task file
  const task = await loadTask(destinationFolder);
  // Step 3: overlapping paths
  await checkOverlaps(task, destinationFolder);
  // Step 4: file list, same disk, free space (compared by the caller: see notEnoughSpace)
  const list = await buildFileList(task, report, signal);
  await checkSameDisk(destinationFolder, list.sources, report);
  let space: SpaceEstimate | null = null;

  try {
    const destination = await destinationSpace(destinationFolder);
    space = { required: requiredSpace(list, destination.blockSize), available: destination.available };
  } catch (error) {
    report.warn(`cannot determine free space in the destination folder: ${describeError(error)} - the space check is skipped`);
  }

  return { task, list, space };
}

/** The "not enough space" text, or null if there is enough space or it is unknown. */
export function notEnoughSpace(destinationFolder: string, space: SpaceEstimate | null): string | null {
  if (!space || space.required <= space.available) {
    return null;
  }

  return `not enough space in the destination folder ${destinationFolder}: required about ${formatBytes(space.required)} (with a margin), available ${formatBytes(space.available)}`;
}

async function resolveLinks(targetPath: string): Promise<string> {
  try {
    return await fileSystemOperations.realpath(targetPath);
  } catch {
    return path.resolve(targetPath); // a missing path is compared as given
  }
}

/** Overlapping paths (step 3): compared after resolving links and always case-insensitively. */
export async function checkOverlaps(task: ValidatedTask, destinationFolder: string): Promise<void> {
  const destination = await resolveLinks(destinationFolder);
  const sources = await Promise.all(task.sources.map(async (source) => ({ source, real: await resolveLinks(source.path) })));
  const errors: string[] = [];

  for (const { source, real } of sources) {
    const label = `sources[${source.index}] (${source.path})`;

    if (isSameOrInside(destination, real)) {
      errors.push(`the destination folder ${destinationFolder} is inside ${label} or equals it - the backup would be written into the data being backed up`);
    } else if (isSameOrInside(real, destination)) {
      errors.push(`${label} is inside the destination folder ${destinationFolder} - the data being backed up would include the backup being written`);
    }
  }

  for (let i = 0; i < sources.length; i++) {
    for (let j = 0; j < sources.length; j++) {
      if (i === j) {
        continue;
      }

      const inner = sources[i]!;
      const outer = sources[j]!;

      if (isSameOrInside(inner.real, outer.real) && (i > j || !isSameOrInside(outer.real, inner.real))) {
        errors.push(`sources[${inner.source.index}] (${inner.source.path}) is inside sources[${outer.source.index}] (${outer.source.path}) or equals it`);
      }
    }
  }

  if (errors.length) {
    throw new StartError(errors);
  }
}

/** "Same disk" check: a source on the same device as the destination folder does not protect against disk failure. */
async function checkSameDisk(destinationFolder: string, lists: SourceList[], report: RunReport): Promise<void> {
  let destinationDevice: bigint;

  try {
    destinationDevice = (await fileSystemOperations.stat(destinationFolder)).dev;
  } catch {
    return;
  }

  for (const sourceList of lists) {
    if (sourceList.dev !== null && sourceList.dev === destinationDevice) {
      report.warn(`source "${sourceList.source.name}" (${sourceList.source.path}) is on the same disk as the destination folder - such a backup does not protect against disk failure`);
    }
  }
}

/** Free space in the destination folder. */
async function destinationSpace(destinationFolder: string): Promise<{ blockSize: number; available: number }> {
  const stats = await fileSystemOperations.statfs(destinationFolder);

  return { blockSize: stats.bsize, available: stats.bavail * stats.bsize };
}

function roundUp(size: number, blockSize: number): number {
  return blockSize > 0 ? Math.ceil(size / blockSize) * blockSize : size;
}

/** Required space: each file rounded up to the block (uncompressed size for compressed sources) + margin. */
function requiredSpace(list: FileList, blockSize: number): number {
  let total = 0;

  for (const sourceList of list.sources) {
    for (const entry of sourceList.entries) {
      if (entry.type === 'file') {
        total += roundUp(entry.size, blockSize);
      }
    }
  }

  return total + Math.max(Math.ceil(total * 0.01), MINIMUM_MARGIN);
}
