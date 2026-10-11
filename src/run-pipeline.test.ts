import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { fileSystemError, fileSystemOperations, patchFileSystemOperations, resetFileSystemOperations, type FileHandle } from './services/file-system-operations.js';
import { retrySettings } from './services/safe-file-system.js';
import { assertBackupMatchesSource, crashAfter, createScenario, finalLines } from './test-support/scenario.js';
import { makeTemporaryDirectory } from './test-support/test-directory.js';
import { copySettings } from './services/copier.js';

let root: string;
let cleanup: () => Promise<void>;

before(async () => {
  ({ directory: root, cleanup } = await makeTemporaryDirectory());
  copySettings.retryPauseMilliseconds = 1;
  retrySettings.delaysMilliseconds = [1, 1];
});

after(() => cleanup());
afterEach(() => resetFileSystemOperations());

const realOpen = fileSystemOperations.open;

/** Replaces methods of handles opened for paths matching `match`. */
function patchHandles(
  match: (filePath: string, flags: string) => boolean,
  overrides: Partial<Record<keyof FileHandle, (...parameters: never[]) => unknown>>,
): void {
  patchFileSystemOperations({
    open: async (filePath, flags, mode) => {
      const fileHandle = await realOpen(filePath, flags, mode);

      if (!match(filePath, flags)) {
        return fileHandle;
      }

      return new Proxy(fileHandle, {
        get(target, property) {
          const override = (overrides as Record<string | symbol, unknown>)[property];

          if (override) {
            return override;
          }

          const value = Reflect.get(target, property);

          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });
}

/** The lines of a log for one task, without the time. */
function logLines(log: string): string[] {
  return log
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice('2026-10-04 11:20:15.123 '.length));
}

test('successful backup: only the data in the backup data folder, mtime, the log and the same lines in the console', async () => {
  const scenario = await createScenario(root, 'ok');
  // with microseconds: preserved beyond milliseconds
  const mtimeSeconds = 1_577_934_245.678_912;
  await fsPromises.utimes(path.join(scenario.source, 'a.txt'), mtimeSeconds, mtimeSeconds);
  const sourceMtimeNs = (await fsPromises.stat(path.join(scenario.source, 'a.txt'), { bigint: true })).mtimeNs;
  const result = await scenario.run();
  assert.equal(result.code, 0, result.stderr);
  await assertBackupMatchesSource(scenario);
  assert.deepEqual(
    (await fsPromises.readdir(scenario.destinationFolder)).sort(),
    ['af-backup-task.json', path.basename(scenario.dataFolder), path.basename(scenario.logFile)].sort(),
  );
  assert.match(path.basename(scenario.dataFolder), /^backup-data-\d{4}(-\d\d){5}$/);
  assert.equal(path.basename(scenario.logFile), `${path.basename(scenario.dataFolder).replace('backup-data-', 'backup-')}.log`);
  const copiedMtimeNs = (await fsPromises.stat(path.join(scenario.dataFolder, 'docs', 'a.txt'), { bigint: true })).mtimeNs;
  const mtimeDifferenceNs = copiedMtimeNs - sourceMtimeNs;
  assert.ok(mtimeDifferenceNs > -1000n && mtimeDifferenceNs < 1000n, `source ${sourceMtimeNs}, copy ${copiedMtimeNs}`);

  const log = await scenario.log();
  const lines = logLines(log);
  assert.match(lines[0]!, /^INFO {2}Backup started: destination folder .*work; machine .*, af-backup .*, Node .*, time zone /);
  // a warning found while building the list (before the log file existed) is in the log, before the folder creation
  const sameDisk = lines.findIndex((line) => /^WARN {2}source "docs" .* is on the same disk as the destination folder/.test(line));
  const created = lines.indexOf(`INFO  Backup data folder created: ${scenario.dataFolder}`);
  assert.ok(sameDisk > 0 && created > sameDisk, log);
  assert.match(lines[lines.length - 2]!, /^INFO {2}Summary: copied 2 files \/ 3 folders .*excluded 1 \(\*\.tmp: 1\); warnings \d+; errors 0; verification: OK; duration /);
  assert.equal(lines[lines.length - 1], `INFO  Backup finished successfully: ${scenario.dataFolder}, code 0`);

  // the console gets the same lines: INFO to stdout, WARN and ERROR to stderr
  const consoleLines = (result.stdout + result.stderr).split('\n').filter(Boolean);
  assert.deepEqual(new Set(consoleLines), new Set(log.split('\n').filter(Boolean)));
  assert.equal(result.stdout.split('\n').filter(Boolean).every((line) => / INFO {2}/.test(line)), true);
});

test('a backup with the same start time stops the run, nothing is changed; another start time - a new backup next to it', async () => {
  const scenario = await createScenario(root, 'exists');
  scenario.startTime = new Date(2026, 9, 4, 11, 20, 15);
  assert.equal((await scenario.run()).code, 0);
  const log = await scenario.log();

  const again = await scenario.run();
  assert.equal(again.code, 2);
  assert.match(
    again.stderr,
    /Backup could not start, code 2: the destination folder already holds a backup with the same start time \(backup-data-2026-10-04-11-20-15, backup-2026-10-04-11-20-15\.log\): .*work - run again/,
  );
  await assertBackupMatchesSource(scenario);
  assert.equal(await scenario.log(), log, 'the log of the existing backup is not touched');

  // a second later - the next run works and keeps the previous backup
  scenario.startTime = new Date(2026, 9, 4, 11, 20, 16);
  assert.equal((await scenario.run()).code, 0);
  assert.deepEqual((await fsPromises.readdir(scenario.destinationFolder)).sort(), [
    'af-backup-task.json',
    'backup-2026-10-04-11-20-15.log',
    'backup-2026-10-04-11-20-16.log',
    'backup-data-2026-10-04-11-20-15',
    'backup-data-2026-10-04-11-20-16',
  ]);
  await assertBackupMatchesSource(scenario);
  scenario.startTime = new Date(2026, 9, 4, 11, 20, 15);
  await assertBackupMatchesSource(scenario);
  assert.equal(await scenario.log(), log, 'the log of the previous backup is not touched');

  // an empty backup data folder alone and a log alone with the same start time stop the run too
  await scenario.clear();
  await fsPromises.mkdir(scenario.dataFolder);
  assert.equal((await scenario.run()).code, 2);
  assert.deepEqual(await fsPromises.readdir(scenario.dataFolder), []);
  await fsPromises.rmdir(scenario.dataFolder);
  await fsPromises.writeFile(scenario.logFile, 'x');
  assert.equal((await scenario.run()).code, 2);
  assert.equal(await scenario.log(), 'x');
  await assert.rejects(fsPromises.access(scenario.dataFolder));
});

test('a run that could not start leaves nothing; after fixing the task the run works', async () => {
  const scenario = await createScenario(root, 'nostart');
  await scenario.writeTask({ exlude: ['*.tmp'] });
  const invalid = await scenario.run();
  assert.equal(invalid.code, 2);
  assert.match(invalid.stdout, / INFO {2}Backup started: /);
  assert.match(invalid.stderr, /Backup could not start, code 2: task file .*af-backup-task\.json: exlude: unknown field/);
  assert.deepEqual(await fsPromises.readdir(scenario.destinationFolder), ['af-backup-task.json']);

  await scenario.writeTask();
  assert.equal((await scenario.run()).code, 0);
  await assertBackupMatchesSource(scenario);

  // no task file: a mount point without the disk looks like this
  await scenario.clear();
  await fsPromises.rm(scenario.taskFile);
  const noTask = await scenario.run();
  assert.equal(noTask.code, 2);
  assert.match(noTask.stderr, /task file not found: .*af-backup-task\.json - the disk may not be connected/);
  assert.deepEqual(await fsPromises.readdir(scenario.destinationFolder), []);
});

test('a level 3 error: the backup finishes with errors, it stays and blocks a run with the same start time', async () => {
  const scenario = await createScenario(root, 'failed');
  await fsPromises.writeFile(path.join(scenario.source, 'locked.txt'), 'x');
  patchHandles((filePath) => filePath.endsWith('locked.txt'), { read: () => Promise.reject(fileSystemError('EBUSY', 'read')) });
  const failed = await scenario.run();
  resetFileSystemOperations();
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /ERROR docs\/locked\.txt: the file is locked \(EBUSY\), 3 attempts/);
  assert.match(finalLines(await scenario.log())[0]!, /ERROR Backup finished WITH ERRORS: .*work[\\/]backup-data-[-0-9]+ is not a valid backup \(errors 1\), code 1$/);
  assert.ok(await scenario.exists());
  assert.equal((await scenario.run()).code, 2);
});

test('an unfinished file that cannot be deleted: no more attempts, extra in verification, not a faulty disk', async () => {
  const scenario = await createScenario(root, 'leftover');
  await fsPromises.writeFile(path.join(scenario.source, 'locked.txt'), 'x');
  patchHandles((filePath) => filePath.endsWith('locked.txt'), { read: () => Promise.reject(fileSystemError('EBUSY', 'read')) });
  let unlinkCalls = 0;

  patchFileSystemOperations({
    unlink: async (targetPath) => {
      unlinkCalls++;

      throw fileSystemError('EPERM', 'unlink', targetPath);
    },
  });

  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /WARN {2}docs\/locked\.txt: could not delete the unfinished file \(verification will show it as extra\): .*EPERM/);
  assert.match(result.stderr, /ERROR docs\/locked\.txt: the file is locked \(EBUSY\); the unfinished file could not be deleted, so there are no more attempts$/m);
  assert.match(result.stderr, /Verification: extra file: docs\/locked\.txt - an unfinished file that could not be deleted/);
  assert.doesNotMatch(result.stderr, /faulty/);
  assert.match(result.stdout, /Summary: .*errors 2; verification: 1 mismatch;/);
  // one attempt; the deletion itself is retried on transient Windows errors only
  assert.equal(unlinkCalls, retrySettings.enabled ? retrySettings.delaysMilliseconds.length + 1 : 1);
});

test('a disappeared file and a changing file are level 3 errors', async () => {
  const scenario = await createScenario(root, 'l3');
  const realStat = fileSystemOperations.stat;
  let statCalls = 0;

  patchFileSystemOperations({
    stat: async (targetPath) => {
      if (targetPath.endsWith('a.txt')) {
        throw fileSystemError('ENOENT', 'stat', targetPath);
      }

      const stats = await realStat(targetPath);

      if (targetPath.endsWith('b.txt') && ++statCalls % 2 === 0) {
        return { ...stats, mtimeNs: stats.mtimeNs + 1n } as typeof stats;
      }

      return stats;
    },
  });

  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /docs\/a\.txt: the file disappeared during the run/);
  assert.match(result.stderr, /docs\/sub\/b\.txt: the file changed while being copied, 3 attempts/);
  // nothing that failed is left in the backup
  assert.deepEqual(await fsPromises.readdir(path.join(scenario.dataFolder, 'docs', 'sub')), ['empty']);
});

test('level 2: out of space in the middle of a file → with errors', async () => {
  const scenario = await createScenario(root, 'enospc', { tree: { 'big.bin': Buffer.alloc(3 * 1024 * 1024, 1), 'z.txt': 'z' } });
  patchHandles((filePath, flags) => flags === 'wx' && filePath.endsWith('big.bin'), { write: () => Promise.reject(fileSystemError('ENOSPC', 'write')) });
  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Fatal error, the backup is stopped: write error in the backup: .*ENOSPC/);
  assert.match(result.stderr, /Backup finished WITH ERRORS/);
  assert.match(result.stdout, /Summary: .*verification: not done/);
});

test('level 2: fsync failure → with errors', async () => {
  const scenario = await createScenario(root, 'fsync');
  patchHandles((filePath, flags) => flags === 'wx' && filePath.endsWith('b.txt'), { sync: () => Promise.reject(fileSystemError('EIO', 'fsync')) });
  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot flush a file to disk/);
});

test('level 2: a log write error during the run → with errors, copying stops at once', async () => {
  const tree = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.txt`, `${i}`]));
  const scenario = await createScenario(root, 'logfail', { tree });
  let logWrites = 0;

  patchHandles((filePath) => filePath.endsWith('.log'), {
    write: (async (buffer: Buffer, offset: number, length: number) => {
      // the first write is the lines kept before the log file was created; the next one fails
      if (++logWrites > 1) {
        throw fileSystemError('EIO', 'write');
      }

      void buffer;
      void offset;

      return { bytesWritten: length };
    }) as never,
  });

  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Fatal error, the backup is stopped: cannot write the log /);
  assert.match(result.stderr, /Backup finished WITH ERRORS/);
  assert.match(result.stderr, /the lines above may be missing from the log/);
  // the stop does not wait for the end of the source
  const copiedFiles = Number(/Summary: copied (\d+) files/.exec(result.stdout)?.[1]);
  assert.ok(copiedFiles < 20, result.stdout);
});

test('level 2: the log cannot be flushed after the success line → code 1, not 0', async () => {
  const scenario = await createScenario(root, 'logsync');
  patchHandles((filePath) => filePath.endsWith('.log'), { sync: () => Promise.reject(fileSystemError('EIO', 'fsync')) });
  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot write the log .*backup-[-0-9]+\.log: .*\(EIO\) - the lines above may be missing from the log/);
  assert.match(result.stderr, /ERROR Backup finished WITH ERRORS: .*work[\\/]backup-data-[-0-9]+ is not a valid backup \(the log cannot be written\), code 1$/m);
});

test('verification finds a corrupted file → with errors', async () => {
  const scenario = await createScenario(root, 'verify');

  // the copy reads one content, verification - another (bit rot on the destination)
  patchHandles((filePath, flags) => flags === 'r' && filePath.includes(`${path.sep}dest${path.sep}`) && filePath.endsWith('a.txt'), {
    read: (async (buffer: Buffer, offset: number, length: number) => {
      void length;

      if ((buffer as Buffer & { done?: boolean }).done) {
        return { bytesRead: 0, buffer };
      }

      buffer.write('ALPHA', offset);
      (buffer as Buffer & { done?: boolean }).done = true;

      return { bytesRead: 5, buffer };
    }) as never,
  });

  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Verification: content does not match \(SHA-256\): docs\/a\.txt/);
  assert.match(result.stderr, /destination disk may be faulty/);
  assert.match(result.stdout, /Summary: .*verification: 1 mismatch;/);
});

test('missing source → with errors; a missing destination folder is a level 1 error', async () => {
  const scenario = await createScenario(root, 'missing', { sources: [{ path: path.join(root, 'missing', 'nope'), name: 'nope' }] });
  const result = await scenario.run();
  assert.equal(result.code, 1);
  assert.deepEqual(await fsPromises.readdir(scenario.dataFolder), []);

  await fsPromises.rm(scenario.destinationFolder, { recursive: true });
  const notConnected = await scenario.run();
  assert.equal(notConnected.code, 2);
  await assert.rejects(fsPromises.access(scenario.destinationFolder), 'the destination folder is not created');
  assert.match(finalLines(notConnected.stderr)[0]!, /Backup could not start, code 2: the destination folder does not exist: .*the disk may not be connected/);
});

test('interruption: the log says INTERRUPTED, code 3, the folder stays', async () => {
  const scenario = await createScenario(root, 'int');
  const abortController = new AbortController();

  patchHandles((filePath, flags) => flags === 'wx' && filePath.endsWith('b.txt'), {
    write: (async (_buffer: Buffer, _offset: number, length: number) => {
      abortController.abort();

      return { bytesWritten: length };
    }) as never,
  });

  const result = await scenario.run(abortController.signal);
  resetFileSystemOperations();
  assert.equal(result.code, 3);
  assert.match(finalLines(await scenario.log())[0]!, /ERROR Backup INTERRUPTED: .*work[\\/]backup-data-[-0-9]+ is not a valid backup, code 3$/);
  assert.ok(await scenario.exists());
});

test('interruption during the pause before a retry stops the run at once', async () => {
  const scenario = await createScenario(root, 'int-pause');
  const abortController = new AbortController();
  copySettings.retryPauseMilliseconds = 60_000;

  patchFileSystemOperations({
    open: async (filePath, flags, mode) => {
      if (flags === 'r' && filePath.endsWith('a.txt')) {
        setTimeout(() => abortController.abort(), 50);

        throw fileSystemError('EBUSY', 'open', filePath);
      }

      return realOpen(filePath, flags, mode);
    },
  });

  const startedAt = Date.now();

  try {
    const result = await scenario.run(abortController.signal);
    assert.equal(result.code, 3);
    assert.ok(Date.now() - startedAt < 10_000, 'the pause is cut short');
  } finally {
    copySettings.retryPauseMilliseconds = 1;
  }
});

test('short writes are completed: the backup succeeds', async () => {
  const scenario = await createScenario(root, 'short', { tree: { 'plain/a.txt': 'alpha', 'packed/b.txt': 'beta' } });

  await scenario.writeTask({
    sources: [
      { path: path.join(scenario.source, 'plain'), name: 'plain' },
      { path: path.join(scenario.source, 'packed'), name: 'packed', compress: true },
    ],
  });

  patchFileSystemOperations({
    open: async (filePath, flags, mode) => {
      const fileHandle = await realOpen(filePath, flags, mode);

      if (flags !== 'wx') {
        return fileHandle;
      }

      const write = fileHandle.write.bind(fileHandle) as (buffer: Buffer, offset: number, length: number, position: number | null) => Promise<unknown>;

      return new Proxy(fileHandle, {
        get(target, property) {
          if (property === 'write') {
            // at most 3 bytes per call
            return (buffer: Buffer, offset: number, length: number, position: number | null) => write(buffer, offset, Math.min(length, 3), position);
          }

          const value = Reflect.get(target, property);

          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });

  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fsPromises.readFile(path.join(scenario.dataFolder, 'plain', 'a.txt'), 'utf8'), 'alpha');
  assert.deepEqual((await fsPromises.readdir(scenario.dataFolder)).sort(), ['packed.tar.gz', 'plain']);
});

test('a log created by another run after the checks is not touched', async () => {
  const scenario = await createScenario(root, 'race-log');

  patchFileSystemOperations({
    open: async (filePath, flags, mode) => {
      if (filePath === scenario.logFile) {
        // another process created the log after the checks
        await fsPromises.writeFile(scenario.logFile, 'theirs');
      }

      return realOpen(filePath, flags, mode);
    },
  });

  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Backup could not start, code 2: cannot create the log .*backup-[-0-9]+\.log:.*another run with this destination folder may have just started/);
  assert.equal(await scenario.log(), 'theirs');
  await assert.rejects(fsPromises.access(scenario.dataFolder));
});

test('a log created but not writable: could not start, the file stays and stops the next run with the same start time', async () => {
  const scenario = await createScenario(root, 'log-unwritable');

  patchFileSystemOperations({
    open: async (filePath, flags, mode) => {
      const fileHandle = await realOpen(filePath, flags, mode);

      if (filePath !== scenario.logFile) {
        return fileHandle;
      }

      return new Proxy(fileHandle, {
        get(target, property) {
          if (property === 'write') {
            return async () => {
              throw fileSystemError('EIO', 'write');
            };
          }

          const value = Reflect.get(target, property);

          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });

  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Backup could not start, code 2: the log .*backup-[-0-9]+\.log was created but cannot be written: .*\(EIO\) - the file stays \(it is not a valid backup\)/);
  assert.equal(await scenario.log(), '');
  await assert.rejects(fsPromises.access(scenario.dataFolder));

  const nextResult = await scenario.run();
  assert.equal(nextResult.code, 2);
  assert.match(nextResult.stderr, /the destination folder already holds a backup with the same start time \(backup-[-0-9]+\.log\)/);

  // a run with another start time is not stopped by the leftover log
  const leftoverLog = scenario.logFile;
  scenario.startTime = new Date(scenario.startTime.getTime() + 1000);
  assert.equal((await scenario.run()).code, 0);
  assert.equal(await fsPromises.readFile(leftoverLog, 'utf8'), '');
});

test('backup-data created by another run after the log: "could not start" in the log, their folder is not touched', async () => {
  const scenario = await createScenario(root, 'race-data');
  const realMkdir = fileSystemOperations.mkdir;

  patchFileSystemOperations({
    mkdir: async (targetPath) => {
      if (targetPath === scenario.dataFolder) {
        await fsPromises.mkdir(scenario.dataFolder);
        await fsPromises.writeFile(path.join(scenario.dataFolder, 'theirs.txt'), 'x');
      }

      return realMkdir(targetPath);
    },
  });

  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 2);
  const lines = logLines(await scenario.log());
  assert.match(lines[0]!, /^INFO {2}Backup started: /);
  assert.match(lines[lines.length - 1]!, /^ERROR Backup could not start, code 2: cannot create the backup data folder .*another run with this destination folder/);
  assert.deepEqual(await fsPromises.readdir(scenario.dataFolder), ['theirs.txt']);
});

test('interruption while verification walks the folder: interrupted, not a mismatch', async () => {
  const scenario = await createScenario(root, 'intverify');
  const abortController = new AbortController();
  const realReaddir = fileSystemOperations.readdir;

  patchFileSystemOperations({
    readdir: async (directoryPath) => {
      if (directoryPath === scenario.dataFolder) {
        abortController.abort();
      }

      return realReaddir(directoryPath);
    },
  });

  const result = await scenario.run(abortController.signal);
  resetFileSystemOperations();
  assert.equal(result.code, 3, result.stderr);
  assert.doesNotMatch(result.stderr, /faulty/);
});

test('a crash at each step: "finished successfully" only for a complete backup, a leftover blocks a run with the same start time', async () => {
  const scenario = await createScenario(root, 'crash');

  for (let operationLimit = 0; ; operationLimit++) {
    const reached = crashAfter(operationLimit);
    await scenario.run();
    resetFileSystemOperations();

    if (/ Backup finished successfully: /.test(await scenario.log())) {
      await assertBackupMatchesSource(scenario);
    }

    const left = await scenario.exists();
    const result = await scenario.run();

    if (left) {
      assert.equal(result.code, 2, `crash after ${operationLimit} operations: ${result.stderr}`);
    } else {
      assert.equal(result.code, 0, `crash after ${operationLimit} operations: ${result.stderr}`);
      await assertBackupMatchesSource(scenario);
    }

    await scenario.clear();

    if (!reached()) {
      break;
    }
  }
});
