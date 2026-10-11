import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';
import { test } from 'node:test';
import type { PlatformKind } from '../utilities/platform.js';
import { parseStrictJson } from '../utilities/strict-json.js';
import { validateTask, type ValidationResult } from './task-validator.js';

const WINDOWS_TASK = {
  jsonType: 'af-backup-task',
  version: 1,
  exclude: ['node_modules', 'Thumbs.db', '*.tmp'],
  sources: [
    { path: 'C:\\work\\docs', name: 'work-docs', exclude: ['drafts'] },
    { path: 'C:\\Users\\me\\.gitconfig' },
    { path: 'C:\\work\\notes', compress: true },
  ],
};

function validate(value: unknown, platform: PlatformKind = 'win32'): ValidationResult {
  return validateTask(parseStrictJson(JSON.stringify(value)), platform);
}

function errorsOf(value: unknown, platform: PlatformKind = 'win32'): string[] {
  const result = validate(value, platform);
  assert.equal(result.ok, false, 'expected validation errors');

  return result.ok ? [] : result.errors;
}

test('the templates in templates/ are valid tasks; the Windows one is the spec example', async () => {
  // the tests run from dist/services/
  const templates = new URL('../../templates/', import.meta.url);

  for (const [file, platform] of [
    ['windows/af-backup-task.json', 'win32'],
    ['linux/af-backup-task.json', 'posix'],
    ['macos/af-backup-task.json', 'posix'],
  ] as const) {
    const text = await fsPromises.readFile(new URL(file, templates), 'utf8');
    const result = validateTask(parseStrictJson(text), platform);
    assert.ok(result.ok, `${file}: ${JSON.stringify(result)}`);

    if (platform === 'win32') {
      assert.deepEqual(JSON.parse(text), WINDOWS_TASK);
    }
  }
});

test('the spec example is valid', () => {
  const result = validate(WINDOWS_TASK);
  assert.ok(result.ok);

  assert.deepEqual(
    result.task.sources.map((source) => [source.name, source.path, source.compress, source.exclude]),
    [
      ['work-docs', 'C:\\work\\docs', false, ['drafts']],
      ['.gitconfig', 'C:\\Users\\me\\.gitconfig', false, []],
      ['notes', 'C:\\work\\notes', true, []],
    ],
  );
});

test('posix task with a root source and a name', () => {
  const result = validate({ ...WINDOWS_TASK, sources: [{ path: '/', name: 'root', compress: true }] }, 'posix');
  assert.ok(result.ok);
  assert.equal(result.task.sources[0]!.compress, true);
});

test('jsonType and version', () => {
  for (const jsonType of ['something', 'af-backup-task-v1']) {
    assert.deepEqual(errorsOf({ ...WINDOWS_TASK, jsonType }), ['this is not an af-backup task file (the "jsonType" field must be "af-backup-task")']);
  }

  const { jsonType: _, ...noType } = WINDOWS_TASK;
  assert.match(errorsOf(noType)[0]!, /not an af-backup task file/);
  assert.match(errorsOf([1, 2])[0]!, /not an af-backup task file/);

  assert.deepEqual(errorsOf({ ...WINDOWS_TASK, version: 2 }), ['task format is newer than the program - update af-backup']);
  const { version: __, ...noVersion } = WINDOWS_TASK;
  assert.deepEqual(errorsOf(noVersion), ['version: required field is missing']);
  assert.deepEqual(errorsOf({ ...WINDOWS_TASK, version: '1' }), ['version: must be 1, got a string "1"']);
  assert.deepEqual(errorsOf({ ...WINDOWS_TASK, version: 1.5 }), ['version: must be 1, got the number 1.5']);
  assert.deepEqual(errorsOf({ ...WINDOWS_TASK, version: 0 }), ['version: must be 1, got the number 0']);
});

test('unknown fields and types - all errors at once with paths', () => {
  const errors = errorsOf({
    ...WINDOWS_TASK,
    exlude: [],
    description: 3,
    sources: [{ path: 'C:\\a', compres: true }, { path: 'C:\\b', name: 'x:y', compress: 'yes' }],
  });

  assert.deepEqual(errors.sort(), [
    'description: must be a string, got the number 3',
    'exlude: unknown field',
    'sources[0].compres: unknown field',
    'sources[1].compress: must be true or false, got a string "yes"',
    'sources[1].name: invalid character ":"',
  ]);
});

test('field rules', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ copies: 3 }, /^copies: unknown field/],
    [{ id: 'x' }, /^id: unknown field/],
    [{ key: 'work' }, /^key: unknown field/],
    // the destination is the folder the task file lies in, not a field
    [{ destination: 'E:\\backups\\work' }, /^destination: unknown field/],
    [{ description: 5 }, /^description:/],
    [{ exclude: 'node_modules' }, /^exclude: must be an array/],
    [{ exclude: ['ok', 'build/'] }, /^exclude\[1\]:/],
    [{ sources: [] }, /^sources: at least one source/],
    [{ sources: [{ path: 'D:\\' }] }, /^sources\[0\]\.name: required for the root/],
    [{ sources: [{ path: '\\\\server\\share' }] }, /^sources\[0\]\.name: required for the root/],
    [{ sources: [{ path: 'C:\\a\\CON' }] }, /^sources\[0\]\.name: name "CON" taken from the path is invalid/],
    [{ sources: [{ path: 'C:\\a\\Docs' }, { path: 'C:\\b\\docs' }] }, /^sources\[1\]\.name: name "docs" is already used by sources\[0\]/],
    [{ sources: [{ path: 'C:\\a\\x', compress: true }, { path: 'C:\\b\\X.tar.gz' }] }, /^sources\[0\]\.name: archive name "x\.tar\.gz" matches the name of sources\[1\]/],
    [{ sources: [{ path: 'C:\\a\\x', exclude: ['**'] }] }, /^sources\[0\]\.exclude\[0\]:/],
    [{ sources: ['C:\\a'] }, /^sources\[0\]: must be an object/],
    [{ sources: [{ name: 'x' }] }, /^sources\[0\]\.path: required field is missing/],
  ];

  for (const [patch, expected] of cases) {
    const errors = errorsOf({ ...WINDOWS_TASK, ...patch });
    assert.ok(errors.some((error) => expected.test(error)), `${JSON.stringify(patch)} → ${JSON.stringify(errors)}`);
  }
});

test('required fields', () => {
  assert.deepEqual(errorsOf({ jsonType: 'af-backup-task', version: 1 }), ['sources: required field is missing']);
});
