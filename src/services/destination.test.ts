import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { StartError } from '../utilities/errors.js';
import { makeTemporaryDirectory } from '../test-support/test-directory.js';
import { backupNames, startTimeStamp } from '../utilities/destination-layout.js';
import { checkDestination } from './destination.js';

let directory: string;
let cleanup: () => Promise<void>;

before(async () => {
  ({ directory, cleanup } = await makeTemporaryDirectory());
});

after(() => cleanup());

// 2026-10-04 11:20:15 local time
const START_TIME = new Date(2026, 9, 4, 11, 20, 15, 123);

async function destinationErrors(destinationFolder: string): Promise<string[]> {
  try {
    await checkDestination(destinationFolder, backupNames(destinationFolder, START_TIME));
  } catch (error) {
    assert.ok(error instanceof StartError);

    return error.messages;
  }

  return [];
}

test('backup names: the local start time to the second', () => {
  const names = backupNames(path.join('E:', 'backups', 'work'), START_TIME);
  assert.equal(names.dataFolderName, 'backup-data-2026-10-04-11-20-15');
  assert.equal(names.logFileName, 'backup-2026-10-04-11-20-15.log');
  assert.equal(names.dataFolder, path.join('E:', 'backups', 'work', 'backup-data-2026-10-04-11-20-15'));
  assert.equal(names.logFile, path.join('E:', 'backups', 'work', 'backup-2026-10-04-11-20-15.log'));
  assert.equal(startTimeStamp(new Date(987, 0, 2, 3, 4, 5)), '0987-01-02-03-04-05');
});

test('the destination folder must exist and hold no backup with the same start time', async () => {
  const destinationFolder = path.join(directory, 'work');
  await fsPromises.mkdir(destinationFolder);
  // anything else in the destination folder does not matter, including backups with other start times
  // and the names without a start time used by earlier versions
  await fsPromises.writeFile(path.join(destinationFolder, 'af-backup-task.json'), '{}');
  await fsPromises.mkdir(path.join(destinationFolder, '2026-10-03'));
  await fsPromises.mkdir(path.join(destinationFolder, 'backup-data-2026-10-04-11-20-14'));
  await fsPromises.writeFile(path.join(destinationFolder, 'backup-2026-10-04-11-20-16.log'), '');
  await fsPromises.mkdir(path.join(destinationFolder, 'backup-data'));
  await fsPromises.writeFile(path.join(destinationFolder, 'backup.log'), '');
  assert.deepEqual(await destinationErrors(destinationFolder), []);

  assert.match((await destinationErrors(path.join(directory, 'missing')))[0]!, /the destination folder does not exist: .*the disk may not be connected/);
  await fsPromises.writeFile(path.join(directory, 'file'), 'x');
  assert.match((await destinationErrors(path.join(directory, 'file')))[0]!, /the destination is not a folder/);
  assert.match((await destinationErrors(path.join(directory, 'file', 'work')))[0]!, /the destination folder does not exist/);

  const dataFolder = path.join(destinationFolder, 'backup-data-2026-10-04-11-20-15');
  const logFile = path.join(destinationFolder, 'backup-2026-10-04-11-20-15.log');
  await fsPromises.mkdir(dataFolder);
  assert.match(
    (await destinationErrors(destinationFolder))[0]!,
    /already holds a backup with the same start time \(backup-data-2026-10-04-11-20-15\): .*work - run again/,
  );
  await fsPromises.writeFile(logFile, '');
  assert.match(
    (await destinationErrors(destinationFolder))[0]!,
    /already holds a backup with the same start time \(backup-data-2026-10-04-11-20-15, backup-2026-10-04-11-20-15\.log\)/,
  );
  await fsPromises.rmdir(dataFolder);
  // a file with the name of the backup data folder counts too
  await fsPromises.writeFile(dataFolder, '');
  await fsPromises.rm(logFile);
  assert.match((await destinationErrors(destinationFolder))[0]!, /already holds a backup with the same start time \(backup-data-2026-10-04-11-20-15\)/);
});
