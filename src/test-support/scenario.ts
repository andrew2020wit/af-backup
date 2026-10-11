// End-to-end scenarios run in-process: sources and a destination folder with the task file in a temporary folder.

import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { runCli } from '../cli.js';
import { ConsoleOutput, MemoryStream } from '../services/console-output.js';
import { fileSystemError, fileSystemOperations, patchFileSystemOperations, type FileHandle } from '../services/file-system-operations.js';
import { backupNames, taskFilePath } from '../utilities/destination-layout.js';
import { writeTree } from './test-directory.js';

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Scenario {
  base: string;
  source: string;
  /** The destination folder (exists, holds the task file). */
  destinationFolder: string;
  /**
   * The start time of the next runs (whole seconds; by default the time the scenario was created): it names the backup,
   * so a run with the same start time as an existing backup could not start.
   */
  startTime: Date;
  /** The backup data folder of a run with `startTime` (does not exist before the run). */
  readonly dataFolder: string;
  /** The log of a run with `startTime`. */
  readonly logFile: string;
  taskFile: string;
  /** Writes the task file: the default task with these fields replaced. */
  writeTask(fields?: Record<string, unknown>): Promise<void>;
  /** `af-backup [extra arguments] <destination folder>`, in-process. */
  run(signal?: AbortSignal, extraArguments?: string[]): Promise<CliRun>;
  /** Whether the backup with `startTime` (its backup data folder or its log) exists in the destination folder. */
  exists(): Promise<boolean>;
  /** Deletes the backup with `startTime` (the backup data folder and the log), so that the next run can start. */
  clear(): Promise<void>;
  /** The content of the log with `startTime`, '' if there is none. */
  log(): Promise<string>;
}

export async function createScenario(
  root: string,
  name: string,
  options: { tree?: Record<string, string | Buffer>; task?: Record<string, unknown>; sources?: unknown[] } = {},
): Promise<Scenario> {
  const base = path.join(root, name);
  const source = path.join(base, 'src');
  const destinationFolder = path.join(base, 'dest', 'work');
  const taskFile = taskFilePath(destinationFolder);
  await writeTree(source, options.tree ?? { 'a.txt': 'alpha', 'sub/b.txt': 'beta', 'sub/empty/': '', 'skip.tmp': 'tmp' });
  await fsPromises.mkdir(destinationFolder, { recursive: true });

  const writeTask = (fields: Record<string, unknown> = {}) =>
    fsPromises.writeFile(
      taskFile,
      JSON.stringify({
        jsonType: 'af-backup-task',
        version: 1,
        exclude: ['*.tmp'],
        sources: options.sources ?? [{ path: source, name: 'docs' }],
        ...options.task,
        ...fields,
      }),
    );

  await writeTask();

  const run = async (signal = new AbortController().signal, extraArguments: string[] = []): Promise<CliRun> => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const consoleOutput = new ConsoleOutput(stdout, stderr);
    const code = await runCli([...extraArguments, destinationFolder], { consoleOutput, signal, now: () => scenario.startTime });

    return { code, stdout: stdout.text, stderr: stderr.text };
  };

  const exists = async (targetPath: string) => {
    try {
      await fsPromises.lstat(targetPath);

      return true;
    } catch {
      return false;
    }
  };

  const startTime = new Date();
  startTime.setMilliseconds(0);

  const scenario: Scenario = {
    base,
    source,
    destinationFolder,
    startTime,
    get dataFolder() {
      return backupNames(destinationFolder, scenario.startTime).dataFolder;
    },
    get logFile() {
      return backupNames(destinationFolder, scenario.startTime).logFile;
    },
    taskFile,
    writeTask,
    run,
    exists: async () => (await exists(scenario.dataFolder)) || (await exists(scenario.logFile)),
    clear: async () => {
      await fsPromises.rm(scenario.dataFolder, { recursive: true, force: true });
      await fsPromises.rm(scenario.logFile, { force: true });
    },
    log: () => fsPromises.readFile(scenario.logFile, 'utf8').catch(() => ''),
  };

  return scenario;
}

/** Relative paths of a folder tree: folders end with `/`, files map to their content. */
async function readTree(root: string): Promise<Map<string, string>> {
  const tree = new Map<string, string>();

  const visit = async (folder: string, relativePath: string) => {
    for (const name of await fsPromises.readdir(folder)) {
      const childRelativePath = relativePath ? `${relativePath}/${name}` : name;
      const childPath = path.join(folder, name);

      if ((await fsPromises.lstat(childPath)).isDirectory()) {
        tree.set(`${childRelativePath}/`, '');
        await visit(childPath, childRelativePath);
      } else {
        tree.set(childRelativePath, await fsPromises.readFile(childPath, 'utf8'));
      }
    }
  };

  await visit(root, '');

  return tree;
}

/**
 * The main invariant for the default scenario layout: a backup is exactly the source (without `*.tmp`)
 * in the subfolder `docs`, with nothing else in the backup data folder.
 */
export async function assertBackupMatchesSource(scenario: Scenario): Promise<void> {
  const expected = new Map([...(await readTree(scenario.source))].filter(([relativePath]) => !relativePath.endsWith('.tmp')));
  assert.deepEqual(await fsPromises.readdir(scenario.dataFolder), ['docs'], 'only the source subfolder is in the backup data folder');
  assert.deepEqual(await readTree(path.join(scenario.dataFolder, 'docs')), expected, 'the backup matches the source');
}

/** The final lines in a log or console output ("finished successfully", "WITH ERRORS", "INTERRUPTED", "could not start"). */
export function finalLines(log: string): string[] {
  return log.split('\n').filter((line) => / Backup (finished|INTERRUPTED|could not start)/.test(line));
}

const WRITE_FLAGS = /[wa+]/;
const MUTATING_HANDLE_METHODS = new Set<string | symbol>(['write', 'writeFile', 'sync', 'truncate', 'utimes', 'datasync']);

/**
 * Simulates a power loss after `operationLimit` mutating operations: every later mutating operation (including writes
 * through file handles) fails with EIO, so nothing more reaches the disk. Returns a function telling
 * whether the crash point was reached.
 */
export function crashAfter(operationLimit: number): () => boolean {
  let count = 0;

  const tick = (operation: string) => {
    if (++count > operationLimit) {
      throw fileSystemError('EIO', `${operation} (simulated crash)`);
    }
  };

  const real = { ...fileSystemOperations };

  const wrapHandle = (fileHandle: FileHandle): FileHandle =>
    new Proxy(fileHandle, {
      get(target, property) {
        const value = Reflect.get(target, property);

        if (typeof value !== 'function') {
          return value;
        }

        if (MUTATING_HANDLE_METHODS.has(property)) {
          return (...callArguments: unknown[]) => {
            tick(String(property));

            return (value as (...parameters: unknown[]) => unknown).apply(target, callArguments);
          };
        }

        return (value as (...parameters: unknown[]) => unknown).bind(target);
      },
    });

  patchFileSystemOperations({
    open: async (filePath, flags, mode) => {
      if (WRITE_FLAGS.test(flags)) {
        tick('open');
      }

      return wrapHandle(await real.open(filePath, flags, mode));
    },
    mkdir: async (targetPath) => (tick('mkdir'), real.mkdir(targetPath)),
    unlink: async (targetPath) => (tick('unlink'), real.unlink(targetPath)),
  });

  return () => count > operationLimit;
}
