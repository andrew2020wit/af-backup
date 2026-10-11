import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommandLine } from './arguments.js';

test('the destination folder and --compute-size in any order; without a folder - the current folder', () => {
  assert.deepEqual(parseCommandLine(['work']), { ok: true, destinationFolder: 'work', computeSize: false });
  assert.deepEqual(parseCommandLine(['E:\\backups\\work']), { ok: true, destinationFolder: 'E:\\backups\\work', computeSize: false });
  assert.deepEqual(parseCommandLine(['./-odd']), { ok: true, destinationFolder: './-odd', computeSize: false });
  assert.deepEqual(parseCommandLine([]), { ok: true, destinationFolder: '.', computeSize: false });
  assert.deepEqual(parseCommandLine(['--compute-size']), { ok: true, destinationFolder: '.', computeSize: true });
  assert.deepEqual(parseCommandLine(['--compute-size', 'work']), { ok: true, destinationFolder: 'work', computeSize: true });
  assert.deepEqual(parseCommandLine(['work', '--compute-size']), { ok: true, destinationFolder: 'work', computeSize: true });
});

test('invalid arguments', () => {
  const problem = (argv: string[]) => {
    const parsed = parseCommandLine(argv);
    assert.equal(parsed.ok, false, argv.join(' '));

    return parsed.ok ? '' : parsed.problem;
  };

  for (const argv of [[''], ['a', 'b'], ['--help'], ['--version'], ['-h'], ['--tasks-dir', 'x'], ['run', 'work'], ['--compute-size', '--compute-size']]) {
    assert.match(problem(argv), /usage: af-backup \[--compute-size\] \[<destination folder>\]/, argv.join(' '));
  }

  assert.match(problem(['--help']), /unknown option: --help \(the only option is --compute-size\)/);
  assert.match(problem(['--compute-size', 'work', '--compute-size']), /--compute-size is given twice/);
  assert.match(problem(['a', 'b']), /at most one destination folder is expected, got a and b/);
  assert.match(problem(['work', '']), /an empty argument/);
});
