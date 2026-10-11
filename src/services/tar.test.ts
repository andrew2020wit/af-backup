import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import * as zlib from 'node:zlib';
import { makeTemporaryDirectory } from '../test-support/test-directory.js';
import { USTAR_MAXIMUM_SIZE, entryHeaders, formatPaxTime, tarEnd } from './tar-format.js';
import { scanTarGz } from './tar-reader.js';
import { TarGzWriter } from './tar-writer.js';

let directory: string;
let cleanup: () => Promise<void>;

before(async () => {
  ({ directory, cleanup } = await makeTemporaryDirectory());
});

after(() => cleanup());

const signal = new AbortController().signal;
const sha256Of = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function addBuffer(writer: TarGzWriter, relativePath: string, data: Buffer, failAfter?: number): Promise<void> {
  await writer.addFile(relativePath, async (sink) => {
    await sink.begin(data.length, 1_600_000_000_123_456_789n);

    for (let i = 0; i < data.length; i += 1000) {
      if (failAfter !== undefined && i >= failAfter) {
        throw new Error('simulated read failure');
      }

      await sink.write(data.subarray(i, i + 1000));
    }
  });
}

test('pax time', () => {
  assert.equal(formatPaxTime(1_600_000_000_000_000_000n), '1600000000');
  assert.equal(formatPaxTime(1_600_000_000_500_000_000n), '1600000000.5');
  assert.equal(formatPaxTime(-1_500_000_000n), '-1.5');
});

test('write and read back; a failed entry is rolled back by truncation', async () => {
  const file = path.join(directory, 'a.tar.gz');
  const writer = await TarGzWriter.create(file);
  const longName = `${'каталог/'.repeat(20)}файл 😀.txt`;
  const big = Buffer.alloc(300_000, 7);
  await writer.addDirectory('folder', 0n);
  await addBuffer(writer, 'folder/one.txt', Buffer.from('one'));
  const sizeBefore = writer.size;
  await assert.rejects(addBuffer(writer, 'folder/broken.bin', big, 50_000), /simulated/);
  assert.equal(writer.size, sizeBefore);
  assert.equal((await fsPromises.stat(file)).size, sizeBefore);
  await addBuffer(writer, 'folder/broken.bin', big);
  await addBuffer(writer, longName, Buffer.from('deep'));
  await addBuffer(writer, 'empty.bin', Buffer.alloc(0));
  const { size, sha256 } = await writer.finish();

  const content = await fsPromises.readFile(file);
  assert.equal(content.length, size);
  assert.equal(sha256Of(content), sha256);
  // a standard multi-member gunzip sees one tar stream ending with two zero blocks
  const tar = zlib.gunzipSync(content);
  assert.ok(tar.subarray(tar.length - 1024).every((byte) => byte === 0));

  const scan = await scanTarGz(file, signal);
  assert.deepEqual(scan.problems, []);
  assert.ok(scan.ended);
  assert.equal(scan.fileSha256, sha256);

  assert.deepEqual(
    scan.entries.map((entry) => [entry.type, entry.path, entry.size, entry.sha256]),
    [
      ['dir', 'folder', 0, undefined],
      ['file', 'folder/one.txt', 3, sha256Of(Buffer.from('one'))],
      ['file', 'folder/broken.bin', big.length, sha256Of(big)],
      ['file', longName, 4, sha256Of(Buffer.from('deep'))],
      ['file', 'empty.bin', 0, sha256Of(Buffer.alloc(0))],
    ],
  );
});

test('corruption and truncation are detected', async () => {
  const file = path.join(directory, 'c.tar.gz');
  const writer = await TarGzWriter.create(file);

  for (let i = 0; i < 5; i++) {
    await addBuffer(writer, `f${i}.bin`, Buffer.alloc(10_000, i));
  }

  await writer.finish();
  const content = await fsPromises.readFile(file);

  const corrupted = Buffer.from(content);
  corrupted[Math.floor(corrupted.length / 2)]! ^= 0xff;
  await fsPromises.writeFile(path.join(directory, 'c1.tar.gz'), corrupted);
  const corruptedScan = await scanTarGz(path.join(directory, 'c1.tar.gz'), signal);

  assert.ok(
    corruptedScan.problems.length > 0 || corruptedScan.entries.some((entry) => entry.sha256 !== sha256Of(Buffer.alloc(10_000, Number(entry.path[1])))),
  );

  await fsPromises.writeFile(path.join(directory, 'c2.tar.gz'), content.subarray(0, content.length - 30));
  const truncatedScan = await scanTarGz(path.join(directory, 'c2.tar.gz'), signal);
  assert.ok(truncatedScan.problems.length > 0 || !truncatedScan.ended);
});

test('an invalid entry size in a pax header is a problem, not a crash', async () => {
  const headers = entryHeaders('huge.bin', 'file', USTAR_MAXIMUM_SIZE + 1, 0n);
  const sizeText = Buffer.from(String(USTAR_MAXIMUM_SIZE + 1));
  const at = headers.indexOf(sizeText);
  assert.ok(at > 0);
  // same length, so the pax header stays consistent; only the value is not a number
  Buffer.from('x'.repeat(sizeText.length)).copy(headers, at);
  const file = path.join(directory, 'bad-size.tar.gz');
  await fsPromises.writeFile(file, Buffer.concat([zlib.gzipSync(headers), zlib.gzipSync(tarEnd())]));
  const scan = await scanTarGz(file, signal);
  assert.match(scan.problems.join('; '), /invalid entry size/);
});
