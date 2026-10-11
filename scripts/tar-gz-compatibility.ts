// .tar.gz compatibility check (docs/spec.md, "Compression" → "Compatibility check").
//
// Prototype of the format from spec: tar POSIX pax (a pax extended header for each entry: path, mtime,
// size from 8 GiB), each entry is a separate gzip member, the tar end is a separate member.
// The script creates test data, packs it, checks the archive with its own reader, extracts it
// with the available tools and compares the result by SHA-256.
//
// Runs without a build (Node.js >= 22.18): node scripts/tar-gz-compatibility.ts <command> ...
//
//   all <work-dir> [--big-size=8G+1M] [--files=70100] [--keep]
//       everything at once: generate (if <work-dir>/src does not exist yet) → pack → verify-archive → auto
//   generate <dir> [--big-size=8G+1M] [--files=70100]
//       test data; --big-size=0 - without the big file
//   pack <source-dir> <archive.tar.gz>
//       pack; <archive.tar.gz>.manifest.json is written next to it - the reference for the checks
//   verify-archive <archive.tar.gz>
//       check the archive with our own reader (gunzip of all members, tar headers, SHA-256 of entries)
//   auto <archive.tar.gz> <work-dir> [--keep]
//       extract with each tool found (bsdtar, GNU tar, 7-Zip, Python tarfile) into
//       <work-dir>/extract-<tool> and compare; without --keep the extracted data is deleted
//   check <archive.tar.gz> <extracted-dir>
//       compare data extracted manually (File Explorer, Finder) with the reference
//
// Disk space for the full set: source ~8 GiB + archive ~8 GiB + one extraction ~8 GiB.
// Put <work-dir> into a registered test data folder, e.g. test-data/<YYYY-MM-DD_HHmmss>-tar-gz-compatibility/
// (AGENTS.md, "Test data"), so the data is not lost track of if a run is interrupted.

import { spawn, spawnSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const BLOCK = 512;
const USTAR_MAXIMUM_SIZE = 8 ** 11 - 1; // 8 GiB - 1: anything larger does not fit into the octal size field
const SMALL_FILE = 1 << 20; // files up to 1 MiB are compressed whole in memory, larger ones as a stream
const ROLLBACK_TARGET = 'rollback/target.bin'; // a failure and rollback by truncation are simulated on this file
const DEFAULT_BIG_SIZE = '8G+1M';
const DEFAULT_FILES = 70_100;

interface SourceEntry {
  type: 'file' | 'dir';
  relativePath: string; // path from the source root, separator '/'
  absolutePath: string;
  size: number;
  mtimeNs: bigint;
}

interface ManifestEntry {
  type: 'file' | 'dir';
  path: string;
  size?: number;
  sha256?: string;
  mtimeNs: string;
}

interface Manifest {
  createdAt: string;
  members: number;
  entries: ManifestEntry[];
}

// ---------- common helpers ----------

function parseSize(text: string): number {
  let total = 0;

  for (const part of text.split('+')) {
    const match = /^(\d+)([KMG]?)$/i.exec(part.trim());

    if (!match) {
      throw new Error(`invalid size: ${text}`);
    }

    const multiplier = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2]!.toUpperCase()]!;
    total += Number(match[1]) * multiplier;
  }

  return total;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  }

  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }

  return `${bytes} bytes`;
}

function formatMtime(nanoseconds: bigint): string {
  if (nanoseconds < 0n) {
    throw new Error('the prototype does not support times before 1970');
  }

  const seconds = nanoseconds / 1_000_000_000n;
  const fraction = nanoseconds % 1_000_000_000n;

  if (fraction === 0n) {
    return `${seconds}`;
  }

  return `${seconds}.${fraction.toString().padStart(9, '0').replace(/0+$/, '')}`;
}

function compareNames(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        await worker(items[next++]!);
      }
    }),
  );
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of fs.createReadStream(file, { highWaterMark: SMALL_FILE })) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

async function isEmptyOrMissing(directory: string): Promise<boolean> {
  try {
    return (await fsPromises.readdir(directory)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true;
    }

    throw error;
  }
}

function manifestPath(archive: string): string {
  return `${archive}.manifest.json`;
}

async function readManifest(archive: string): Promise<Manifest> {
  return JSON.parse(await fsPromises.readFile(manifestPath(archive), 'utf8')) as Manifest;
}

// ---------- generate ----------

async function writeRandomFile(file: string, size: number): Promise<void> {
  await fsPromises.mkdir(path.dirname(file), { recursive: true });
  const fileHandle = await fsPromises.open(file, 'wx');

  try {
    const cipher = createCipheriv('aes-128-ctr', randomBytes(16), randomBytes(16)); // fast incompressible data
    const zero = Buffer.alloc(SMALL_FILE);
    let position = 0;

    while (position < size) {
      const length = Math.min(size - position, zero.length);
      const chunk = cipher.update(zero.subarray(0, length));
      await fileHandle.write(chunk, 0, chunk.length, position);
      position += length;

      if (size > 1024 ** 3 && position % 1024 ** 3 === 0) {
        console.log(`  ${path.basename(file)}: ${formatBytes(position)}`);
      }
    }
  } finally {
    await fileHandle.close();
  }
}

async function writeText(root: string, relativePath: string, text: string): Promise<string> {
  const file = path.join(root, ...relativePath.split('/'));
  await fsPromises.mkdir(path.dirname(file), { recursive: true });
  await fsPromises.writeFile(file, text, { flag: 'wx' });

  return file;
}

async function generate(directory: string, bigSize: number, files: number): Promise<void> {
  if (!(await isEmptyOrMissing(directory))) {
    throw new Error(`folder is not empty: ${directory}`);
  }

  console.log(`Test data → ${directory}`);

  if (bigSize > 0) {
    console.log(`Big incompressible file: ${formatBytes(bigSize)}`);
    await writeRandomFile(path.join(directory, '0-big', 'big-incompressible.bin'), bigSize);
  }

  console.log(`Small files: ${files}`);
  const perDirectory = 700;
  const indexes = Array.from({ length: files }, (_, i) => i);

  await pool(indexes, 32, async (i) => {
    const subdirectory = `d${String(Math.floor(i / perDirectory)).padStart(3, '0')}`;
    await writeText(directory, `many/${subdirectory}/f${String(i).padStart(6, '0')}.txt`, `file ${i}\n`.repeat(1 + (i % 50)));
  });

  // Non-ASCII names below are deliberate test data (Cyrillic, emoji), not text to translate.
  console.log('Special cases');
  await writeText(directory, 'кириллица/Документ с пробелами.txt', 'Cyrillic in the name\n');
  await writeText(directory, 'кириллица/Ёжик в тумане/Отчёт №1.md', '# Report\n');
  await writeText(directory, 'emoji/😀 улыбка.txt', 'non-BMP character in the file name\n');
  await writeText(directory, 'emoji/папка 🎉/файл.txt', 'non-BMP character in the folder name\n');
  await writeText(directory, `long-name/${'n'.repeat(150)}.txt`, 'name longer than 100 bytes (ustar name field)\n');
  await writeText(directory, `long-name/${'Длинное имя '.repeat(8).trim()}.txt`, 'Cyrillic name longer than 100 bytes\n');
  const longDirectories = Array.from({ length: 6 }, (_, i) => `каталог-с-длинным-именем-номер-${i}-${'x'.repeat(14)}`);
  await writeText(directory, `long-path/${longDirectories.join('/')}/файл-в-конце-длинного-пути.txt`, 'path longer than 260 characters\n');
  await writeText(directory, "special/a&b (1) [x] {y} #%+,;=@^'.txt", 'special characters valid on Windows\n');
  await writeText(directory, 'special/.hidden', 'name starting with a dot\n');
  await writeText(directory, 'sizes/empty.bin', '');
  await writeText(directory, 'sizes/block-512.bin', 'a'.repeat(512));
  await writeText(directory, 'sizes/block-513.bin', 'a'.repeat(513));
  await writeRandomFile(path.join(directory, 'sizes', 'random-1m.bin'), SMALL_FILE);
  await writeRandomFile(path.join(directory, ...ROLLBACK_TARGET.split('/')), 3 * SMALL_FILE);

  const times: [string, number][] = [
    ['times/fractional-2001.txt', Date.parse('2001-02-03T04:05:06.789Z') / 1000],
    ['times/old-1990.txt', Date.parse('1990-06-15T12:00:00Z') / 1000],
    ['times/after-2038.txt', Date.parse('2100-01-01T00:00:00.5Z') / 1000],
  ];

  for (const [relativePath, mtime] of times) {
    const file = await writeText(directory, relativePath, `modification time ${new Date(mtime * 1000).toISOString()}\n`);
    await fsPromises.utimes(file, mtime, mtime);
  }

  await fsPromises.mkdir(path.join(directory, 'empty-dir'));
  await fsPromises.mkdir(path.join(directory, 'nested', 'empty', 'inner-empty'), { recursive: true });
}

// ---------- writing tar.gz ----------

async function walkSource(root: string): Promise<SourceEntry[]> {
  const entries: SourceEntry[] = [];

  async function visit(absoluteDirectory: string, relativeDirectory: string): Promise<void> {
    for (const name of (await fsPromises.readdir(absoluteDirectory)).sort(compareNames)) {
      const absolutePath = path.join(absoluteDirectory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stats = await fsPromises.lstat(absolutePath, { bigint: true });

      if (stats.isDirectory()) {
        entries.push({ type: 'dir', relativePath, absolutePath, size: 0, mtimeNs: stats.mtimeNs });
        await visit(absolutePath, relativePath); // a folder comes before its content
      } else if (stats.isFile()) {
        entries.push({ type: 'file', relativePath, absolutePath, size: Number(stats.size), mtimeNs: stats.mtimeNs });
      } else {
        throw new Error(`unsupported item type: ${absolutePath}`);
      }
    }
  }

  await visit(root, '');

  return entries;
}

function truncateUtf8(bytes: Buffer, maximumLength: number): Buffer {
  if (bytes.length <= maximumLength) {
    return bytes;
  }

  let end = maximumLength;

  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end--; // do not cut in the middle of a character
  }

  return bytes.subarray(0, end);
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');

  if (text.length > length - 1) {
    throw new Error(`value ${value} does not fit into the tar field`);
  }

  header.write(`${text}\0`, offset, length, 'ascii');
}

// The name in the ustar header is a fallback for tools without pax support: the full name is in pax.
function setUstarName(header: Buffer, name: string): void {
  const bytes = Buffer.from(name, 'utf8');

  if (bytes.length <= 100) {
    bytes.copy(header, 0);

    return;
  }

  for (let i = bytes.indexOf(0x2f); i !== -1; i = bytes.indexOf(0x2f, i + 1)) {
    if (i <= 155 && bytes.length - i - 1 <= 100 && bytes.length - i - 1 > 0) {
      bytes.copy(header, 345, 0, i); // prefix
      bytes.copy(header, 0, i + 1); // name

      return;
    }
  }

  truncateUtf8(bytes, 100).copy(header, 0);
}

function ustarHeader(name: string, typeflag: string, size: number, mtimeNs: bigint): Buffer {
  const header = Buffer.alloc(BLOCK);
  setUstarName(header, name);
  writeOctal(header, 100, 8, typeflag === '5' ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid

  if (size <= USTAR_MAXIMUM_SIZE) {
    writeOctal(header, 124, 12, size);
  } else {
    // base-256 (GNU extension, understood by GNU tar, libarchive, 7-Zip); the exact size is in pax too
    let value = BigInt(size);

    for (let i = 135; i > 124; i--) {
      header[i] = Number(value & 0xffn);
      value >>= 8n;
    }

    header[124] = 0x80;
  }

  writeOctal(header, 136, 12, Number(mtimeNs / 1_000_000_000n));
  header.write('        ', 148, 8, 'ascii'); // the checksum is computed with spaces in its own field
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeOctal(header, 329, 8, 0); // devmajor
  writeOctal(header, 337, 8, 0); // devminor
  let sum = 0;

  for (const byte of header) {
    sum += byte;
  }

  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

  return header;
}

function paxData(fields: [string, string][]): Buffer {
  const records = fields.map(([key, value]) => {
    const bodyLength = Buffer.byteLength(` ${key}=${value}\n`, 'utf8');
    let length = bodyLength + String(bodyLength).length;

    while (String(length).length + bodyLength !== length) {
      length = String(length).length + bodyLength;
    }

    return `${length} ${key}=${value}\n`;
  });

  return Buffer.from(records.join(''), 'utf8');
}

function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

function entryHeaders(entry: SourceEntry): Buffer {
  const name = entry.type === 'dir' ? `${entry.relativePath}/` : entry.relativePath;

  const fields: [string, string][] = [
    ['path', name],
    ['mtime', formatMtime(entry.mtimeNs)],
  ];

  if (entry.size > USTAR_MAXIMUM_SIZE) {
    fields.push(['size', String(entry.size)]);
  }

  const pax = paxData(fields);
  const baseName = Buffer.from(path.posix.basename(entry.relativePath), 'utf8');
  const paxName = `PaxHeader/${truncateUtf8(baseName, 80).toString('utf8')}`;

  return Buffer.concat([
    ustarHeader(paxName, 'x', pax.length, entry.mtimeNs),
    pax,
    padding(pax.length),
    ustarHeader(name, entry.type === 'dir' ? '5' : '0', entry.type === 'dir' ? 0 : entry.size, entry.mtimeNs),
  ]);
}

class SimulatedFailure extends Error {}

async function writeGzipBuffer(fileHandle: fsPromises.FileHandle, position: number, data: Buffer): Promise<number> {
  const member = zlib.gzipSync(data);
  await fileHandle.write(member, 0, member.length, position);

  return member.length;
}

// A gzip member for a large file: headers + streamed data + padding. Returns the member length.
async function writeGzipStream(
  fileHandle: fsPromises.FileHandle,
  position: number,
  entry: SourceEntry,
  hash: ReturnType<typeof createHash>,
  failAfter: number | null,
): Promise<number> {
  const gzip = zlib.createGzip();

  const consumer = (async () => {
    let writePosition = position;

    for await (const chunk of gzip as AsyncIterable<Buffer>) {
      await fileHandle.write(chunk, 0, chunk.length, writePosition);
      writePosition += chunk.length;
    }

    return writePosition - position;
  })();

  const push = async (buffer: Buffer) => {
    if (!gzip.write(buffer)) {
      await once(gzip, 'drain');
    }
  };

  try {
    await push(entryHeaders(entry));
    let read = 0;
    let nextReport = 1024 ** 3;

    for await (const chunk of fs.createReadStream(entry.absolutePath, { highWaterMark: SMALL_FILE }) as AsyncIterable<Buffer>) {
      hash.update(chunk);
      read += chunk.length;
      await push(chunk);

      if (failAfter !== null && read >= failAfter) {
        throw new SimulatedFailure();
      }

      if (read >= nextReport) {
        console.log(`  ${entry.relativePath}: ${formatBytes(read)}`);
        nextReport += 1024 ** 3;
      }
    }

    if (read !== entry.size) {
      throw new Error(`file changed while being packed: ${entry.relativePath}`);
    }

    await push(padding(entry.size));
    gzip.end();

    return await consumer;
  } catch (error) {
    gzip.destroy();
    await consumer.catch(() => 0);
    throw error;
  }
}

async function pack(sourceDirectory: string, archive: string): Promise<void> {
  console.log(`Packing ${sourceDirectory} → ${archive}`);
  const entries = await walkSource(sourceDirectory);
  const fileHandle = await fsPromises.open(archive, 'wx');
  const manifest: Manifest = { createdAt: new Date().toISOString(), members: 0, entries: [] };
  let position = 0;
  let done = 0;

  try {
    for (const entry of entries) {
      if (entry.type === 'dir') {
        position += await writeGzipBuffer(fileHandle, position, entryHeaders(entry));
        manifest.entries.push({ type: 'dir', path: entry.relativePath, mtimeNs: entry.mtimeNs.toString() });
      } else {
        let sha256: string;

        if (entry.size <= SMALL_FILE) {
          const data = await fsPromises.readFile(entry.absolutePath);

          if (data.length !== entry.size) {
            throw new Error(`file changed while being packed: ${entry.relativePath}`);
          }

          sha256 = createHash('sha256').update(data).digest('hex');
          position += await writeGzipBuffer(fileHandle, position, Buffer.concat([entryHeaders(entry), data, padding(entry.size)]));
        } else {
          if (entry.relativePath === ROLLBACK_TARGET) {
            // Simulated failure mid-write: the gzip member is unfinished, the archive is truncated to its start.
            try {
              await writeGzipStream(fileHandle, position, entry, createHash('sha256'), SMALL_FILE);
            } catch (error) {
              if (!(error instanceof SimulatedFailure)) {
                throw error;
              }
            }

            const sizeBefore = (await fileHandle.stat()).size;
            await fileHandle.truncate(position);
            console.log(`  rollback: ${entry.relativePath} - archive truncated from ${sizeBefore} to ${position} bytes, the entry is retried`);
          }

          const hash = createHash('sha256');
          position += await writeGzipStream(fileHandle, position, entry, hash, null);
          sha256 = hash.digest('hex');
        }

        manifest.entries.push({ type: 'file', path: entry.relativePath, size: entry.size, sha256, mtimeNs: entry.mtimeNs.toString() });
      }

      manifest.members++;

      if (++done % 10_000 === 0) {
        console.log(`  entries: ${done}`);
      }
    }

    position += await writeGzipBuffer(fileHandle, position, Buffer.alloc(2 * BLOCK)); // the tar end is a separate member
    manifest.members++;
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  await fsPromises.writeFile(manifestPath(archive), JSON.stringify(manifest, null, 1));
  const files = manifest.entries.filter((manifestEntry) => manifestEntry.type === 'file').length;
  console.log(`Done: ${files} files, ${manifest.entries.length - files} folders, ${manifest.members} gzip members, archive ${formatBytes(position)}`);
}

// ---------- reading tar.gz (our own reader) ----------

class ByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(byteCount: number): Promise<boolean> {
    while (this.buffer.length < byteCount && !this.ended) {
      const next = await this.iterator.next();

      if (next.done) {
        this.ended = true;
      } else {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : next.value;
      }
    }

    return this.buffer.length >= byteCount;
  }

  async read(byteCount: number): Promise<Buffer | null> {
    if (!(await this.fill(byteCount))) {
      return null;
    }

    const bytes = this.buffer.subarray(0, byteCount);
    this.buffer = this.buffer.subarray(byteCount);

    return bytes;
  }

  async stream(byteCount: number, onChunk: (chunk: Buffer) => void): Promise<boolean> {
    let left = byteCount;

    while (left > 0) {
      if (this.buffer.length === 0 && !(await this.fill(1))) {
        return false;
      }

      const take = Math.min(left, this.buffer.length);
      onChunk(this.buffer.subarray(0, take));
      this.buffer = this.buffer.subarray(take);
      left -= take;
    }

    return true;
  }

  async rest(onChunk: (chunk: Buffer) => void): Promise<void> {
    while (await this.fill(1)) {
      onChunk(this.buffer);
      this.buffer = Buffer.alloc(0);
    }
  }
}

function cString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);

  return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

function parseNumber(header: Buffer, offset: number, length: number): number {
  if (header[offset]! & 0x80) {
    let value = BigInt(header[offset]! & 0x7f);

    for (let i = offset + 1; i < offset + length; i++) {
      value = (value << 8n) | BigInt(header[i]!);
    }

    return Number(value);
  }

  const text = cString(header, offset, length).trim();

  return text === '' ? 0 : parseInt(text, 8);
}

function parsePax(data: Buffer): Map<string, string> {
  const fields = new Map<string, string>();
  let position = 0;

  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    const length = parseInt(data.subarray(position, space).toString('ascii'), 10);
    const record = data.subarray(space + 1, position + length - 1).toString('utf8');
    const equalsIndex = record.indexOf('=');
    fields.set(record.slice(0, equalsIndex), record.slice(equalsIndex + 1));
    position += length;
  }

  return fields;
}

async function verifyArchive(archive: string): Promise<boolean> {
  console.log(`Checking the archive with our own reader: ${archive}`);
  const manifest = await readManifest(archive);
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const problems: string[] = [];
  const gunzip = zlib.createGunzip(); // decompresses all gzip members in a row
  const input = fs.createReadStream(archive);
  input.on('error', (error) => gunzip.destroy(error));
  const reader = new ByteReader(input.pipe(gunzip) as AsyncIterable<Buffer>);
  let pax = new Map<string, string>();
  let seen = 0;
  let ended = false;

  while (true) {
    const header = await reader.read(BLOCK);

    if (!header) {
      break;
    }

    if (header.every((byte) => byte === 0)) {
      const second = await reader.read(BLOCK);

      if (!second || !second.every((byte) => byte === 0)) {
        problems.push('tar end: the second zero block is missing');
      }

      let trailing = 0;

      await reader.rest((chunk) => {
        if (!chunk.every((byte) => byte === 0)) {
          trailing += chunk.length;
        }
      });

      if (trailing) {
        problems.push(`non-zero data after the tar end (${trailing} bytes)`);
      }

      ended = true;
      break;
    }

    let sum = 0;

    for (let i = 0; i < BLOCK; i++) {
      sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    }

    if (sum !== parseNumber(header, 148, 8)) {
      problems.push(`invalid header checksum (entry ${seen + 1})`);
    }

    if (cString(header, 257, 6) !== 'ustar') {
      problems.push(`no ustar signature (entry ${seen + 1})`);
    }

    const typeflag = String.fromCharCode(header[156]!);
    let size = parseNumber(header, 124, 12);

    if (typeflag === 'x') {
      const data = await reader.read(size + padding(size).length);

      if (!data) {
        break;
      }

      pax = parsePax(data.subarray(0, size));
      continue;
    }

    const prefix = cString(header, 345, 155);
    const name = pax.get('path') ?? (prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100));

    if (pax.has('size')) {
      size = Number(pax.get('size'));
    }

    const mtime = pax.get('mtime');
    pax = new Map();
    const relativePath = name.replace(/\/$/, '');
    const expectedEntry = expected.get(relativePath);
    seen++;

    if (typeflag === '5') {
      if (!expectedEntry) {
        problems.push(`extra folder: ${relativePath}`);
      } else if (expectedEntry.type !== 'dir') {
        problems.push(`expected a file, the archive has a folder: ${relativePath}`);
      }
    } else if (typeflag === '0' || typeflag === '\0') {
      const hash = createHash('sha256');

      if (!(await reader.stream(size, (chunk) => hash.update(chunk))) || !(await reader.read(padding(size).length))) {
        problems.push(`archive is cut off at entry: ${relativePath}`);
        break;
      }

      if (!expectedEntry) {
        problems.push(`extra file: ${relativePath}`);
      } else if (expectedEntry.type !== 'file') {
        problems.push(`expected a folder, the archive has a file: ${relativePath}`);
      } else if (expectedEntry.size !== size) {
        problems.push(`size ${size} instead of ${expectedEntry.size}: ${relativePath}`);
      } else if (expectedEntry.sha256 !== hash.digest('hex')) {
        problems.push(`SHA-256 mismatch: ${relativePath}`);
      }
    } else {
      problems.push(`unexpected entry type "${typeflag}": ${relativePath}`);
    }

    if (expectedEntry && mtime !== formatMtime(BigInt(expectedEntry.mtimeNs))) {
      problems.push(`mtime ${mtime} instead of ${formatMtime(BigInt(expectedEntry.mtimeNs))}: ${relativePath}`);
    }

    expected.delete(relativePath);
  }

  if (!ended) {
    problems.push('no tar end (two zero blocks)');
  }

  for (const relativePath of expected.keys()) {
    problems.push(`not in the archive: ${relativePath}`);
  }

  printProblems(problems);
  console.log(problems.length ? `ERRORS: ${problems.length}` : `OK: ${seen} entries, everything matches the reference`);

  return problems.length === 0;
}

function printProblems(problems: string[]): void {
  for (const problem of problems.slice(0, 30)) {
    console.log(`  - ${problem}`);
  }

  if (problems.length > 30) {
    console.log(`  … and ${problems.length - 30} more`);
  }
}

// ---------- comparing extracted data ----------

interface CheckResult {
  ok: boolean;
  summary: string;
}

interface FoundEntry {
  type: 'file' | 'dir' | 'other';
  absolutePath: string;
  size: number;
  mtimeNs: bigint;
}

async function walkExtracted(root: string): Promise<Map<string, FoundEntry>> {
  const entries = new Map<string, FoundEntry>();

  async function visit(absoluteDirectory: string, relativeDirectory: string): Promise<void> {
    for (const name of await fsPromises.readdir(absoluteDirectory)) {
      const absolutePath = path.join(absoluteDirectory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stats = await fsPromises.lstat(absolutePath, { bigint: true });
      const type = stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other';
      entries.set(relativePath, { type, absolutePath, size: Number(stats.size), mtimeNs: stats.mtimeNs });

      if (type === 'dir') {
        await visit(absolutePath, relativePath);
      }
    }
  }

  await visit(root, '');

  return entries;
}

// File Explorer and Finder extract into a folder named after the archive - descend into it.
async function findContentRoot(directory: string, manifest: Manifest): Promise<string> {
  const top = new Set(manifest.entries.map((entry) => entry.path.split('/')[0]!));
  let current = directory;

  for (let depth = 0; depth < 3; depth++) {
    const names = await fsPromises.readdir(current);

    if (names.some((name) => top.has(name))) {
      return current;
    }

    if (names.length !== 1 || !(await fsPromises.stat(path.join(current, names[0]!))).isDirectory()) {
      return current;
    }

    current = path.join(current, names[0]!);
    console.log(`  looking for the content in ${current}`);
  }

  return current;
}

function mtimeClass(differenceNs: bigint): string {
  if (differenceNs === 0n) {
    return 'exact';
  }

  if (differenceNs <= 1_000n) {
    return '≤1 µs';
  }

  if (differenceNs <= 1_000_000n) {
    return '≤1 ms';
  }

  if (differenceNs < 1_000_000_000n) {
    return '<1 s';
  }

  if (differenceNs <= 2_000_000_000n) {
    return '≤2 s';
  }

  return 'not restored';
}

async function check(archive: string, extracted: string): Promise<CheckResult> {
  console.log(`Comparing ${extracted} with the reference ${manifestPath(archive)}`);
  const manifest = await readManifest(archive);
  const extractedEntries = await walkExtracted(await findContentRoot(extracted, manifest));
  const problems: string[] = [];
  const mtimes = new Map<string, number>();
  let missing = 0;
  let wrong = 0;

  for (const expectedEntry of manifest.entries) {
    let relativePath = expectedEntry.path;
    let extractedEntry = extractedEntries.get(relativePath);

    if (!extractedEntry) {
      const alternative = [relativePath.normalize('NFC'), relativePath.normalize('NFD')].find(
        (normalized) => normalized !== relativePath && extractedEntries.has(normalized),
      );

      if (alternative !== undefined) {
        problems.push(`name in a different Unicode normalization: ${relativePath}`);
        relativePath = alternative;
        extractedEntry = extractedEntries.get(alternative);
      }
    }

    if (!extractedEntry) {
      missing++;
      problems.push(`missing: ${expectedEntry.path}`);
      continue;
    }

    extractedEntries.delete(relativePath);

    if (extractedEntry.type !== expectedEntry.type) {
      wrong++;
      problems.push(`type ${extractedEntry.type} instead of ${expectedEntry.type}: ${expectedEntry.path}`);
      continue;
    }

    if (expectedEntry.type === 'dir') {
      continue;
    }

    if (extractedEntry.size !== expectedEntry.size) {
      wrong++;
      problems.push(`size ${extractedEntry.size} instead of ${expectedEntry.size}: ${expectedEntry.path}`);
      continue;
    }

    if ((await sha256File(extractedEntry.absolutePath)) !== expectedEntry.sha256) {
      wrong++;
      problems.push(`SHA-256 mismatch: ${expectedEntry.path}`);
      continue;
    }

    const difference = extractedEntry.mtimeNs - BigInt(expectedEntry.mtimeNs);
    const className = mtimeClass(difference < 0n ? -difference : difference);
    mtimes.set(className, (mtimes.get(className) ?? 0) + 1);
  }

  for (const relativePath of extractedEntries.keys()) {
    problems.push(`extra: ${relativePath}`);
  }

  const extra = extractedEntries.size;

  printProblems(problems);
  const mtimeText = [...mtimes].map(([className, count]) => `${className} ${count}`).join(', ');
  const ok = missing === 0 && wrong === 0 && extra === 0;

  const summary = ok
    ? `OK (modification time: ${mtimeText || '-'})`
    : `ERRORS: missing ${missing}, wrong ${wrong}, extra ${extra} (modification time: ${mtimeText || '-'})`;

  console.log(summary);

  return { ok, summary };
}

// ---------- extraction with third-party tools ----------

interface RunResult {
  code: number | null;
  output: string;
}

function run(command: string, commandArguments: string[], environment?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, commandArguments, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: environment });

    const collect = (data: Buffer) => {
      output = (output + data.toString('utf8')).slice(-4000);
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => resolve({ code: -1, output: String(error) }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

function firstLine(command: string, commandArguments: string[]): string | null {
  const result = spawnSync(command, commandArguments, { encoding: 'utf8', windowsHide: true });

  if (result.error) {
    return null;
  }

  const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).find((outputLine) => outputLine.trim() !== '');

  return line?.trim() ?? '';
}

interface Tool {
  id: string;
  label: string;
  extract(archive: string, extracted: string): Promise<RunResult>;
}

const PYTHON_EXTRACT = [
  'import sys, tarfile',
  "with tarfile.open(sys.argv[1], 'r:gz') as t:",
  "    try: t.extractall(sys.argv[2], filter='fully_trusted')",
  '    except TypeError: t.extractall(sys.argv[2])',
].join('\n');

function detectTools(): Tool[] {
  const tools: Tool[] = [];
  const isWindows = process.platform === 'win32';

  // gnuEnvironment: GNU tar from Git calls gzip from its own folder, which is usually not in PATH
  const tarCandidates: { id: string; command: string; extraArguments: string[]; slashPaths: boolean; gnuEnvironment: boolean }[] = isWindows
    ? [
        { id: 'tar-windows', command: 'C:\\Windows\\System32\\tar.exe', extraArguments: [], slashPaths: false, gnuEnvironment: false },
        { id: 'tar-git', command: 'C:\\Program Files\\Git\\usr\\bin\\tar.exe', extraArguments: ['--force-local'], slashPaths: true, gnuEnvironment: true },
      ]
    : [{ id: 'tar', command: 'tar', extraArguments: [], slashPaths: false, gnuEnvironment: false }];

  for (const candidate of tarCandidates) {
    if (isWindows && !fs.existsSync(candidate.command)) {
      continue;
    }

    const version = firstLine(candidate.command, ['--version']);

    if (version === null) {
      continue;
    }

    const toolPath = (filePath: string) => (candidate.slashPaths ? filePath.replaceAll('\\', '/') : filePath);
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'; // usually "Path" on Windows

    const environment = candidate.gnuEnvironment
      ? { ...process.env, [pathKey]: `${path.dirname(candidate.command)}${path.delimiter}${process.env[pathKey] ?? ''}` }
      : undefined;

    tools.push({
      id: candidate.id,
      label: `${candidate.command} (${version})`,
      extract: (archive, extracted) => run(candidate.command, [...candidate.extraArguments, '-xzf', toolPath(archive), '-C', toolPath(extracted)], environment),
    });
  }

  const sevenZip = (isWindows ? ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'] : [])
    .filter((candidate) => fs.existsSync(candidate))
    .concat(['7z', '7zz', '7za'])
    .find((candidate) => firstLine(candidate, []) !== null);

  if (sevenZip) {
    tools.push({
      id: '7zip',
      label: `${sevenZip} (${firstLine(sevenZip, [])})`,
      extract: async (archive, extracted) => {
        // 7-Zip extracts .tar.gz in two steps: gzip → .tar, then tar → files
        const temporaryDirectory = `${extracted}-tar`;
        await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
        const first = await run(sevenZip, ['x', '-y', `-o${temporaryDirectory}`, archive]);

        if (first.code !== 0) {
          return first;
        }

        const tars = await fsPromises.readdir(temporaryDirectory);

        if (tars.length !== 1) {
          return { code: -1, output: `expected one .tar after gunzip, got: ${tars.join(', ')}` };
        }

        const second = await run(sevenZip, ['x', '-y', `-o${extracted}`, path.join(temporaryDirectory, tars[0]!)]);
        await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });

        return second;
      },
    });
  }

  for (const python of isWindows ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    const version = firstLine(python, ['-c', 'import sys, tarfile; print("Python", sys.version.split()[0])']);

    if (!version || !/^Python \d/.test(version)) {
      continue; // the Microsoft Store stub prints "Python was not found"
    }

    tools.push({
      id: 'python',
      label: `${python} tarfile (${version})`,
      extract: (archive, extracted) => run(python, ['-c', PYTHON_EXTRACT, archive, extracted]),
    });

    break;
  }

  return tools;
}

async function auto(archive: string, workDirectory: string, keep: boolean): Promise<boolean> {
  const tools = detectTools();
  console.log(`Extraction tools: ${tools.length ? tools.map((tool) => tool.id).join(', ') : 'none found'}`);
  const rows: string[] = [];
  let allOk = true;

  for (const tool of tools) {
    const extracted = path.join(workDirectory, `extract-${tool.id}`);
    console.log(`\n=== ${tool.label}`);
    await fsPromises.rm(extracted, { recursive: true, force: true });
    await fsPromises.mkdir(extracted, { recursive: true });
    const started = Date.now();
    const runResult = await tool.extract(archive, extracted);
    const seconds = Math.round((Date.now() - started) / 1000);

    if (runResult.code !== 0) {
      console.log(`Exit code ${runResult.code}. Output (tail):\n${runResult.output.trim()}`);
    }

    const result = await check(archive, extracted);
    allOk &&= result.ok && runResult.code === 0;
    rows.push(`| ${tool.label} | ${runResult.code} | ${seconds} s | ${result.summary} |`);

    if (!keep) {
      await fsPromises.rm(extracted, { recursive: true, force: true });
    }
  }

  console.log('\n| Tool | Exit code | Extraction | Comparison result |');
  console.log('|---|---|---|---|');

  for (const row of rows) {
    console.log(row);
  }

  console.log(`
Manually (compare the result with the check command):
  Windows File Explorer: right-click the archive → "Extract All…" into ${path.join(workDirectory, 'extract-explorer')},
    then: node scripts/tar-gz-compatibility.ts check "${archive}" "${path.join(workDirectory, 'extract-explorer')}"
  Finder (macOS): double-click the archive, then check with the resulting folder.`);

  return allOk;
}

// ---------- entry point ----------

function parseArguments(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (const argument of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);

    if (match) {
      flags.set(match[1]!, match[2] ?? 'true');
    } else {
      positional.push(argument);
    }
  }

  return { positional, flags };
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArguments(rest);

  const requireArguments = (count: number) => {
    if (positional.length !== count) {
      throw new Error(`command ${command} needs ${count} argument(s); see the top of the file`);
    }
  };

  const bigSize = parseSize(flags.get('big-size') ?? DEFAULT_BIG_SIZE);
  const files = Number(flags.get('files') ?? DEFAULT_FILES);
  const keep = flags.has('keep');

  switch (command) {
    case 'generate':
      requireArguments(1);
      await generate(path.resolve(positional[0]!), bigSize, files);

      return 0;
    case 'pack':
      requireArguments(2);
      await pack(path.resolve(positional[0]!), path.resolve(positional[1]!));

      return 0;
    case 'verify-archive':
      requireArguments(1);

      return (await verifyArchive(path.resolve(positional[0]!))) ? 0 : 1;
    case 'check':
      requireArguments(2);

      return (await check(path.resolve(positional[0]!), path.resolve(positional[1]!))).ok ? 0 : 1;
    case 'auto':
      requireArguments(2);

      return (await auto(path.resolve(positional[0]!), path.resolve(positional[1]!), keep)) ? 0 : 1;
    case 'all': {
      requireArguments(1);
      const work = path.resolve(positional[0]!);
      const source = path.join(work, 'src');
      const archive = path.join(work, 'test.tar.gz');

      if (await isEmptyOrMissing(source)) {
        await generate(source, bigSize, files);
      } else {
        console.log(`Using existing test data: ${source}`);
      }

      await fsPromises.rm(archive, { force: true });
      await fsPromises.rm(manifestPath(archive), { force: true });
      await pack(source, archive);
      const archiveOk = await verifyArchive(archive);
      const toolsOk = await auto(archive, work, keep);

      return archiveOk && toolsOk ? 0 : 1;
    }
    default:
      console.log('Commands: all, generate, pack, verify-archive, auto, check - described at the top of the file.');

      return command ? 2 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
