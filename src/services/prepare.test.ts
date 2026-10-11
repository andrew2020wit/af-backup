import assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { StartError } from '../utilities/errors.js';
import { makeTemporaryDirectory, writeTree } from '../test-support/test-directory.js';
import { validateTask, type ValidatedTask } from './task-validator.js';
import { parseStrictJson } from '../utilities/strict-json.js';
import { checkOverlaps } from './prepare.js';

let directory: string;
let cleanup: () => Promise<void>;

before(async () => {
  ({ directory, cleanup } = await makeTemporaryDirectory());
});

after(() => cleanup());

function makeTask(fields: Record<string, unknown>): ValidatedTask {
  const result = validateTask(parseStrictJson(JSON.stringify({ jsonType: 'af-backup-task', version: 1, ...fields })));

  if (!result.ok) {
    throw new Error(result.errors.join('\n'));
  }

  return result.task;
}

test('overlapping paths', async () => {
  const base = path.join(directory, 'ovl');
  await writeTree(base, { 'src/a/': '', 'dest/work/x/': '', 'other/': '' });

  const overlaps = (destinationFolder: string, sources: string[]) =>
    checkOverlaps(makeTask({ sources: sources.map((source, index) => ({ path: path.join(base, source), name: `s${index}` })) }), path.join(base, destinationFolder));

  await overlaps('dest/work', ['src', 'other']);
  await assert.rejects(overlaps('src/a', ['src']), /the backup would be written into the data being backed up/);
  await assert.rejects(overlaps('src', ['src']), StartError);
  await assert.rejects(overlaps('dest/work', ['dest/work/x']), /would include the backup being written/);
  await assert.rejects(overlaps('dest/work', ['src', 'src/a']), /inside sources\[0\]/);
  await assert.rejects(overlaps('dest/work', ['src', 'SRC']), StartError);
  await overlaps('dest/work', ['src', 'src-2']); // a common prefix is not an overlap
  await overlaps('dest/work', ['dest/work-2']);
});
