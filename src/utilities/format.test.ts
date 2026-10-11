import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes } from './format.js';

test('formatBytes: units and trailing zeros of the fractional part only', () => {
  assert.equal(formatBytes(512), '512 bytes');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(2 * 1024), '2 KB');
  assert.equal(formatBytes(50 * 1024), '50 KB');
  assert.equal(formatBytes(120 * 1024), '120 KB');
  assert.equal(formatBytes(100 * 1024 * 1024), '100 MB');
  assert.equal(formatBytes(1000 * 1024 * 1024), '1000 MB');
  assert.equal(formatBytes(3 * 1024 ** 4), '3 TB');
});
