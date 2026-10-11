import assert from 'node:assert/strict';
import type { Dirent } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { makeTemporaryDirectory, writeTree } from '../test-support/test-directory.js';
import { validateTask, type ValidatedTask } from './task-validator.js';
import { parseStrictJson } from '../utilities/strict-json.js';
import { buildFileList } from './file-list.js';
import { fileSystemOperations, patchFileSystemOperations, resetFileSystemOperations } from './file-system-operations.js';
import { RunReport, type ReportEvent } from './run-report.js';

let directory: string;
let cleanup: () => Promise<void>;

before(async () => {
  ({ directory, cleanup } = await makeTemporaryDirectory());
});

after(() => cleanup());

function makeTask(fields: Record<string, unknown>): ValidatedTask {
  const result = validateTask(
    parseStrictJson(JSON.stringify({ jsonType: 'af-backup-task', version: 1, ...fields })),
  );

  if (!result.ok) {
    throw new Error(result.errors.join('\n'));
  }

  return result.task;
}

function collect(): { report: RunReport; events: ReportEvent[] } {
  const events: ReportEvent[] = [];
  const report = new RunReport((event) => events.push(event));

  return { report, events };
}

test('walk: order, exclusions first, mask counters, file source', async () => {
  const source = path.join(directory, 'walk');

  await writeTree(source, {
    'b.txt': 'bb',
    'a/x.tmp': 'x',
    'a/keep.txt': 'k',
    'node_modules/m/index.js': 'm',
    'projects/p1/build/out.bin': 'o',
    'projects/p1/src/main.c': 'c',
    'empty/': '',
    'Thumbs.db': '',
  });

  const file = path.join(directory, 'single.cfg');
  await fsPromises.writeFile(file, 'cfg');

  const task = makeTask({
    exclude: ['node_modules', '*.tmp', 'Thumbs.db', 'never'],
    sources: [{ path: source, name: 'docs', exclude: ['projects/*/build'] }, { path: file, exclude: ['*'.concat('.cfg')] }],
  });

  const { report, events } = collect();
  const list = await buildFileList(task, report, undefined, false);
  const [docs, single] = list.sources;

  assert.deepEqual(
    docs!.entries.map((entry) => `${entry.type}:${entry.relativePath}`),
    ['dir:a', 'file:a/keep.txt', 'file:b.txt', 'dir:empty', 'dir:projects', 'dir:projects/p1', 'dir:projects/p1/src', 'file:projects/p1/src/main.c'],
  );

  assert.equal(docs!.files, 3);
  assert.equal(docs!.bytes, 4);
  assert.equal(docs!.excluded, 4);

  assert.deepEqual(
    list.masks.map((maskCounter) => [maskCounter.label, maskCounter.count]),
    [
      ['node_modules', 1],
      ['*.tmp', 1],
      ['Thumbs.db', 1],
      ['never', 0],
      ['docs/projects/*/build', 1],
      ['single.cfg/*.cfg', 0],
    ],
  );

  // excluded items are not listed one by one - only the counters above (docs/spec.md, "Exclusions")
  assert.ok(!events.some((event) => event.text.includes('node_modules')));
  // a file source: masks are not applied, the entry is the file itself
  assert.equal(single!.kind, 'file');
  assert.deepEqual(single!.entries.map((entry) => entry.relativePath), ['single.cfg']);
  assert.equal(report.errors, 0);
});

test('names are in code point order (not UTF-16 order: a name outside the BMP comes after U+FF21)', async () => {
  const source = path.join(directory, 'order');
  await writeTree(source, { '\u{1F600}.txt': '', 'Ａ.txt': '', 'a.txt': '', 'Z.txt': '' });
  const task = makeTask({ sources: [{ path: source }] });
  const list = await buildFileList(task, collect().report);
  assert.deepEqual(list.sources[0]!.entries.map((entry) => entry.relativePath), ['Z.txt', 'a.txt', 'Ａ.txt', '\u{1F600}.txt']);
});

test('missing and empty sources are level 3 errors', async () => {
  const empty = path.join(directory, 'empty-src');
  await fsPromises.mkdir(empty);
  const task = makeTask({ sources: [{ path: path.join(directory, 'missing') }, { path: empty }] });
  const { report, events } = collect();
  const list = await buildFileList(task, report);
  assert.equal(report.errors, 2);
  assert.match(events[0]!.text, /does not exist/);
  assert.match(events[1]!.text, /is empty - the disk may not be connected/);
  assert.deepEqual(list.sources.map((sourceList) => sourceList.kind), ['unusable', 'unusable']);
});

test('links inside a source are skipped with a warning; the source itself may be a link', async () => {
  const source = path.join(directory, 'links');
  await writeTree(source, { 'real/f.txt': 'f' });
  const target = path.join(directory, 'link-target');
  await writeTree(target, { 'inner.txt': 'i' });

  try {
    await fsPromises.symlink(target, path.join(source, 'jn'), 'junction');
  } catch {
    return; // links cannot be created here
  }

  const viaLink = path.join(directory, 'source-link');
  await fsPromises.symlink(source, viaLink, 'junction');
  const task = makeTask({ sources: [{ path: viaLink, name: 'links' }] });
  const { report, events } = collect();
  const list = await buildFileList(task, report);
  assert.deepEqual(list.sources[0]!.entries.map((entry) => entry.relativePath), ['real', 'real/f.txt']);
  assert.equal(report.warnings, 1);
  assert.match(events.find((event) => event.level === 'WARN')!.text, /^Skipped link: links\/jn -> /);
});

test('an item matching several masks is counted by each of them, but excluded once', async () => {
  const source = path.join(directory, 'several');
  await writeTree(source, { 'cache/a.tmp': 'a', 'keep.txt': 'k' });
  const task = makeTask({ exclude: ['*.tmp'], sources: [{ path: source, name: 'docs', exclude: ['cache/*.tmp'] }] });
  const list = await buildFileList(task, collect().report, undefined, false);

  assert.deepEqual(
    list.masks.map((maskCounter) => [maskCounter.label, maskCounter.count]),
    [
      ['*.tmp', 1],
      ['docs/cache/*.tmp', 1],
    ],
  );
  assert.equal(list.sources[0]!.excluded, 1);
});

test('a name not in UTF-8: exclusions first, otherwise a level 3 error', async () => {
  const source = path.join(directory, 'not-utf8');
  await writeTree(source, { 'a.txt': 'a' });
  const realReaddirBuffer = fileSystemOperations.readdirBuffer;
  // such names cannot be created on Windows and macOS: the folder listing is simulated
  const fakeEntry = (bytes: number[]) => ({ name: Buffer.from(bytes), isDirectory: () => false }) as unknown as Dirent<Buffer>;

  patchFileSystemOperations({
    readdirBuffer: async (directoryPath) => [
      ...(await realReaddirBuffer(directoryPath)),
      // "b\xff.tmp" and "c\xff.txt"
      fakeEntry([0x62, 0xff, 0x2e, 0x74, 0x6d, 0x70]),
      fakeEntry([0x63, 0xff, 0x2e, 0x74, 0x78, 0x74]),
    ],
  });

  try {
    const task = makeTask({ exclude: ['*.tmp'], sources: [{ path: source, name: 'docs' }] });
    const { report, events } = collect();
    const list = await buildFileList(task, report, undefined, false);
    assert.deepEqual(list.sources[0]!.entries.map((entry) => entry.relativePath), ['a.txt']);
    assert.deepEqual(list.masks.map((maskCounter) => [maskCounter.label, maskCounter.count]), [['*.tmp', 1]]);
    assert.equal(report.errors, 1);
    assert.equal(events[0]!.text, 'docs/c\\xff.txt: file name is not in UTF-8 encoding - skipped');
  } finally {
    resetFileSystemOperations();
  }
});

test('a name starting with U+FEFF keeps it', async () => {
  const source = path.join(directory, 'bom');
  await writeTree(source, { '﻿bom.txt': 'b' });
  const task = makeTask({ sources: [{ path: source }] });
  const { report } = collect();
  const list = await buildFileList(task, report);
  assert.deepEqual(list.sources[0]!.entries.map((entry) => entry.relativePath), ['﻿bom.txt']);
  assert.equal(report.errors, 0);
});
