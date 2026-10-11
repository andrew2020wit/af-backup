import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { fileSystemOperations, patchFileSystemOperations, resetFileSystemOperations } from './services/file-system-operations.js';
import { createScenario } from './test-support/scenario.js';
import { makeTemporaryDirectory } from './test-support/test-directory.js';

let root: string;
let cleanup: () => Promise<void>;

before(async () => {
  ({ directory: root, cleanup } = await makeTemporaryDirectory());
});

after(() => cleanup());
afterEach(() => resetFileSystemOperations());

/** The lines of console output, without the time. */
function outputLines(output: string): string[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice('2026-10-04 11:20:15.123 '.length));
}

const COMPUTE_SIZE = ['--compute-size'];

/** Pretends the destination disk has this much free space. */
function freeSpace(bytes: number): void {
  const realStatfs = fileSystemOperations.statfs;

  patchFileSystemOperations({
    statfs: async (targetPath) => ({ ...(await realStatfs(targetPath)), bsize: 4096, bavail: Math.floor(bytes / 4096) }),
  });
}

test('--compute-size: sizes per source and in total, free space; nothing is written', async () => {
  const file = path.join(root, 'single.cfg');
  await fsPromises.writeFile(file, 'cfg');

  const scenario = await createScenario(root, 'compute', {
    tree: { 'a.txt': 'alpha', 'sub/b.txt': 'beta', 'sub/empty/': '', 'skip.tmp': 'tmp' },
    sources: [{ path: path.join(root, 'compute', 'src'), name: 'docs' }, { path: file }],
  });

  freeSpace(10 * 1024 ** 3);
  const result = await scenario.run(undefined, COMPUTE_SIZE);
  assert.equal(result.code, 0, result.stderr);
  const lines = outputLines(result.stdout);
  assert.match(lines[0]!, /^INFO {2}Size computation started: destination folder .*work; machine .*, af-backup .*, time zone /);
  assert.ok(lines.includes(`INFO  Source "docs" (${scenario.source}): 2 files / 2 folders / 9 bytes; excluded 1`), result.stdout);
  assert.ok(lines.includes(`INFO  Source "single.cfg" (${file}): 1 file / 0 folders / 3 bytes; excluded 0`), result.stdout);
  // 3 files of one 4 KB block each + the minimum margin of 100 MB
  assert.ok(lines.includes('INFO  Total: 3 files / 2 folders / 12 bytes; excluded 1 (*.tmp: 1); required about 100 MB with a margin, available 10 GB'), result.stdout);
  assert.equal(lines[lines.length - 1], 'INFO  Size computation finished successfully, code 0');
  assert.deepEqual(await fsPromises.readdir(scenario.destinationFolder), ['af-backup-task.json'], 'nothing is written');
});

test('--compute-size: a compressed source; a missing source is an error, code 1', async () => {
  const scenario = await createScenario(root, 'compute-errors', {
    sources: [
      { path: path.join(root, 'compute-errors', 'src'), name: 'docs', compress: true },
      { path: path.join(root, 'compute-errors', 'missing'), name: 'missing' },
    ],
  });

  const result = await scenario.run(undefined, COMPUTE_SIZE);
  assert.equal(result.code, 1);
  assert.match(result.stdout, / INFO {2}Source "docs" \(.*\): 2 files \/ 2 folders \/ 9 bytes; excluded 1 \(compressed: the archive will be smaller\)\n/);
  assert.match(result.stdout, / INFO {2}Source "missing" \(.*missing\): not available \(see the error above\)\n/);
  assert.match(result.stderr, / ERROR source "missing" \(.*\) does not exist \(ENOENT\)/);
  assert.match(result.stderr, / ERROR Size computation finished WITH ERRORS \(errors 1\), code 1\n$/);
  assert.deepEqual(await fsPromises.readdir(scenario.destinationFolder), ['af-backup-task.json']);
});

test('--compute-size: not enough space is an error, code 1; the backup itself does not start, code 2', async () => {
  const scenario = await createScenario(root, 'compute-space');
  freeSpace(50 * 1024 ** 2);

  const computed = await scenario.run(undefined, COMPUTE_SIZE);
  assert.equal(computed.code, 1);
  assert.match(computed.stdout, /; required about 100 MB with a margin, available 50 MB\n/);
  assert.match(computed.stderr, / ERROR not enough space in the destination folder .*work: required about 100 MB \(with a margin\), available 50 MB\n/);

  const backup = await scenario.run();
  assert.equal(backup.code, 2);
  assert.match(backup.stderr, /Backup could not start, code 2: not enough space in the destination folder/);
  assert.deepEqual(await fsPromises.readdir(scenario.destinationFolder), ['af-backup-task.json']);
});

test('--compute-size: an invalid task - could not start, code 2; a backup with the same start time does not matter', async () => {
  const scenario = await createScenario(root, 'compute-invalid');
  await scenario.writeTask({ exlude: ['*.tmp'] });
  const invalid = await scenario.run(undefined, COMPUTE_SIZE);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, / ERROR Size computation could not start, code 2: task file .*exlude: unknown field/);

  await scenario.writeTask();
  assert.equal((await scenario.run()).code, 0);
  // the backup of this start time exists: a backup would not start, the computation does
  assert.equal((await scenario.run(undefined, COMPUTE_SIZE)).code, 0);
});

test('--compute-size: interrupted - code 3', async () => {
  const scenario = await createScenario(root, 'compute-interrupt');
  const abortController = new AbortController();
  abortController.abort();
  const result = await scenario.run(abortController.signal, COMPUTE_SIZE);
  assert.equal(result.code, 3);
  assert.match(result.stderr, / ERROR Size computation INTERRUPTED, code 3\n$/);
});
