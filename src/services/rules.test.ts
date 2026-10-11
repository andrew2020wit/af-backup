import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAbsolutePath, isRootPath, normalizeAbsolutePath } from './absolute-path.js';
import { checkMask, compileMask } from './masks.js';
import { checkName } from './names.js';

test('absolute paths on Windows', () => {
  for (const ok of ['C:\\work', 'C:/work', 'c:\\', 'D:\\a\\..\\b', '\\\\server\\share', '\\\\server\\share\\dir', '//server/share/dir']) {
    assert.equal(checkAbsolutePath(ok, 'win32'), null, ok);
  }

  for (const bad of ['\\work', '/work', 'C:work', 'C:', 'work', '.\\work', '\\\\?\\C:\\work', '\\\\.\\C:\\work', '\\\\server', '~\\x', '%USERPROFILE%\\x', '']) {
    assert.notEqual(checkAbsolutePath(bad, 'win32'), null, bad);
  }
});

test('absolute paths on Linux/macOS', () => {
  for (const ok of ['/', '/home/me', '/a/../b']) {
    assert.equal(checkAbsolutePath(ok, 'posix'), null, ok);
  }

  for (const bad of ['home', '~/x', './x', 'C:\\x', '']) {
    assert.notEqual(checkAbsolutePath(bad, 'posix'), null, bad);
  }
});

test('root paths', () => {
  assert.ok(isRootPath(normalizeAbsolutePath('D:\\', 'win32'), 'win32'));
  assert.ok(isRootPath(normalizeAbsolutePath('D:/', 'win32'), 'win32'));
  assert.ok(isRootPath(normalizeAbsolutePath('\\\\server\\share', 'win32'), 'win32'));
  assert.ok(isRootPath(normalizeAbsolutePath('/', 'posix'), 'posix'));
  assert.ok(!isRootPath(normalizeAbsolutePath('D:\\x\\', 'win32'), 'win32'));
  assert.ok(!isRootPath(normalizeAbsolutePath('\\\\server\\share\\x', 'win32'), 'win32'));
  assert.ok(!isRootPath(normalizeAbsolutePath('/mnt/', 'posix'), 'posix'));
});

test('source names', () => {
  for (const ok of ['work-docs', '.gitconfig', 'Документы', 'a b', 'CONSOLE', 'con-x', 'x.tar.gz', '😀']) {
    assert.equal(checkName(ok), null, ok);
  }

  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a?', 'a*', 'a"b', 'a<b', 'a|b', 'tab\there', 'end.', 'end ', 'CON', 'con', 'nul.tar.gz', 'CON.txt', 'Com1', 'LPT9.log', 'COM¹']) {
    assert.notEqual(checkName(bad), null, bad);
  }

  assert.match(checkName('a:b')!, /invalid character ":"/);
  assert.match(checkName('a\nb')!, /invalid character "\\x0a"/);
});

test('mask validation', () => {
  for (const ok of ['node_modules', '*.tmp', 'projects/*/build', '**/logs', 'a/**/b', '**/logs/*.log', '.git', 'a?[b]{c}!', '*x*']) {
    assert.equal(checkMask(ok), null, ok);
  }

  for (const bad of ['', 'a\\b', '/build', 'C:/x', 'build/', 'a/./b', '../x', 'a**b', 'a/**', '*', '**', '**/*', '*/*', '***', 'a//b']) {
    assert.notEqual(checkMask(bad), null, bad);
  }
});

function matches(mask: string, relativePath: string, caseInsensitive = false): boolean {
  return compileMask(mask, caseInsensitive).matches(relativePath, relativePath.split('/').pop()!);
}

test('mask matching: by name at any depth', () => {
  assert.ok(matches('node_modules', 'node_modules'));
  assert.ok(matches('node_modules', 'a/b/node_modules'));
  assert.ok(!matches('node_modules', 'node_modules2'));
  assert.ok(matches('*.tmp', 'x/y.tmp'));
  assert.ok(matches('*.tmp', '.tmp'));
  assert.ok(!matches('*.tmp', 'y.tmp.txt'));
  assert.ok(matches('a?[b]', 'x/a?[b]'));
  assert.ok(!matches('a?', 'ab'));
  assert.ok(matches('a.b', 'a.b'));
  assert.ok(!matches('a.b', 'axb'));
});

test('mask matching: anchored from the source root', () => {
  assert.ok(matches('projects/*/build', 'projects/p1/build'));
  assert.ok(!matches('projects/*/build', 'x/projects/p1/build'));
  assert.ok(!matches('projects/*/build', 'projects/p1/q/build'));
  assert.ok(matches('cache/tmp', 'cache/tmp'));
  assert.ok(matches('**/logs', 'logs'));
  assert.ok(matches('**/logs', 'a/b/logs'));
  assert.ok(matches('a/**/b', 'a/b'));
  assert.ok(matches('a/**/b', 'a/x/y/b'));
  assert.ok(!matches('a/**/b', 'a/x/y/c'));
  assert.ok(matches('**/logs/*.log', 'x/logs/1.log'));
  assert.ok(!matches('**/logs/*.log', 'x/logs/sub/1.log'));
});

test('mask matching: case sensitivity is a parameter', () => {
  assert.ok(matches('Thumbs.db', 'thumbs.DB', true));
  assert.ok(!matches('Thumbs.db', 'thumbs.DB', false));
  assert.ok(matches('Projects/*/Build', 'projects/x/build', true));
  assert.ok(!matches('Projects/*/Build', 'projects/x/build', false));
  assert.ok(matches('ДОК*', 'документ', true));
});

test('the drive root masks from the spec are valid and match the service folders', () => {
  for (const mask of ['System Volume Information', '$RECYCLE.BIN', 'lost+found', '.Spotlight-V100', '.Trashes', '.fseventsd']) {
    assert.equal(checkMask(mask), null, mask);
    assert.ok(matches(mask, mask, false), mask);
  }

  // `$` is literal; Windows names the folder differently on different disks
  assert.ok(matches('$RECYCLE.BIN', '$Recycle.Bin', true));
  assert.ok(!matches('$RECYCLE.BIN', 'RECYCLE.BIN', true));
});
