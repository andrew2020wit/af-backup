import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkArguments, destinationArgument } from './arguments.js';

test('the only argument is the destination folder; without it - the current folder', () => {
  for (const argv of [['work'], ['E:\\backups\\work'], ['./-odd'], []]) {
    assert.equal(checkArguments(argv), null, argv.join(' '));
  }

  assert.equal(destinationArgument(['E:\\backups\\work']), 'E:\\backups\\work');
  assert.equal(destinationArgument([]), '.');
});

test('invalid arguments', () => {
  for (const argv of [[''], ['a', 'b'], ['--help'], ['--version'], ['-h'], ['--tasks-dir', 'x'], ['run', 'work']]) {
    assert.match(checkArguments(argv) ?? '', /usage: af-backup \[<destination folder>\]/, argv.join(' '));
  }
});
