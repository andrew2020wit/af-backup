import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { runMain } from './test-support/cli-runner.js';
import { makeTemporaryDirectory, writeTree } from './test-support/test-directory.js';

let directory: string;
let cleanup: () => Promise<void>;

before(async () => {
  ({ directory, cleanup } = await makeTemporaryDirectory());
});

after(() => cleanup());

test('with options, an empty or extra arguments - code 2, a "could not start" line in stderr only', async () => {
  const empty = path.join(directory, 'empty');
  await fsPromises.mkdir(empty);

  for (const commandLineArguments of [[''], ['--help'], ['--version'], ['a', 'b'], ['run', 'work']]) {
    const result = await runMain(commandLineArguments, { cwd: empty });
    assert.equal(result.code, 2, commandLineArguments.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, / ERROR Backup could not start, code 2: .*usage: af-backup \[<destination folder>\]/);
  }

  assert.deepEqual(await fsPromises.readdir(empty), [], 'nothing is created');
});

test('a relative destination folder that does not exist - code 2, nothing is created', async () => {
  const empty = path.join(directory, 'missing-parent');
  await fsPromises.mkdir(empty);
  const result = await runMain(['missing'], { cwd: empty });
  assert.equal(result.code, 2);
  assert.match(result.stdout, / INFO {2}Backup started: destination folder .*missing; /);
  assert.match(result.stderr, / ERROR Backup could not start, code 2: the destination folder does not exist: .*missing - the disk may not be connected/);
  assert.deepEqual(await fsPromises.readdir(empty), []);
});

test('without an argument the destination folder is the current folder', async () => {
  const source = path.join(directory, 'current', 'src');
  const destinationFolder = path.join(directory, 'current', 'work');
  await writeTree(source, { 'a.txt': 'alpha' });
  await fsPromises.mkdir(destinationFolder);

  // without the task file: the current folder is checked, nothing is created
  const noTask = await runMain([], { cwd: destinationFolder });
  assert.equal(noTask.code, 2);
  assert.match(noTask.stderr, /task file not found: .*work[\\/]af-backup-task\.json/);
  assert.deepEqual(await fsPromises.readdir(destinationFolder), []);

  await fsPromises.writeFile(
    path.join(destinationFolder, 'af-backup-task.json'),
    JSON.stringify({ jsonType: 'af-backup-task', version: 1, sources: [{ path: source, name: 'docs' }] }),
  );

  const result = await runMain([], { cwd: destinationFolder });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Backup started: destination folder .*work; /);
  // the names end with the start time of the run
  const names = (await fsPromises.readdir(destinationFolder)).sort();
  assert.equal(names.length, 3, names.join());
  const [, logFileName, dataFolderName] = names as [string, string, string];
  assert.match(dataFolderName, /^backup-data-\d{4}(-\d\d){5}$/);
  assert.equal(logFileName, `backup-${dataFolderName.slice('backup-data-'.length)}.log`);
  assert.equal(await fsPromises.readFile(path.join(destinationFolder, dataFolderName, 'docs', 'a.txt'), 'utf8'), 'alpha');
  assert.match(
    await fsPromises.readFile(path.join(destinationFolder, logFileName), 'utf8'),
    / Backup finished successfully: .*work[\\/]backup-data-[-0-9]+, code 0\n$/,
  );
});
