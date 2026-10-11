import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { StartError } from '../utilities/errors.js';
import { makeTemporaryDirectory } from '../test-support/test-directory.js';
import { loadTask } from './task-loader.js';

let directory: string;
let cleanup: () => Promise<void>;

before(async () => {
  ({ directory, cleanup } = await makeTemporaryDirectory());
});

after(() => cleanup());

function task(extra: Record<string, unknown> = {}): string {
  const source = process.platform === 'win32' ? 'C:\\work' : '/home/me/work';

  return JSON.stringify({ jsonType: 'af-backup-task', version: 1, sources: [{ path: source }], ...extra });
}

test('loads af-backup-task.json from the destination folder (a BOM is allowed)', async () => {
  const destinationFolder = path.join(directory, 'work');
  await fsPromises.mkdir(destinationFolder);
  await fsPromises.writeFile(path.join(destinationFolder, 'af-backup-task.json'), '\uFEFF' + task({ description: 'loaded' }));
  assert.equal((await loadTask(destinationFolder)).description, 'loaded');
});

test('invalid task file - all errors with the file path', async () => {
  const destinationFolder = path.join(directory, 'bad');
  const file = path.join(destinationFolder, 'af-backup-task.json');
  await fsPromises.mkdir(destinationFolder);
  await fsPromises.writeFile(file, task({ copies: 2, destination: 'E:\\backups\\work' }));

  await assert.rejects(loadTask(destinationFolder), (error: unknown) => {
    assert.ok(error instanceof StartError);
    assert.deepEqual(error.messages.sort(), [`task file ${file}: copies: unknown field`, `task file ${file}: destination: unknown field`]);

    return true;
  });

  await assert.rejects(loadTask(path.join(directory, 'missing')), /task file not found: .*af-backup-task\.json - the disk may not be connected/);
  await fsPromises.writeFile(file, Buffer.from([0x7b, 0xff, 0x7d]));
  await assert.rejects(loadTask(destinationFolder), /not in UTF-8/);
  await fsPromises.writeFile(file, '{"jsonType": "af-backup-task", "jsonType": "af-backup-task"}');
  await assert.rejects(loadTask(destinationFolder), /invalid JSON/);
});
