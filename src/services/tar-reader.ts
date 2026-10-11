// .tar.gz reader for verification: the archive is extracted completely in memory as a stream
// (CRC of each gzip member, tar header checksums, tar end), the SHA-256 of each entry is computed.

import { createHash, type Hash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { errorText, throwIfAborted } from '../utilities/errors.js';
import { fileSystemOperations } from './file-system-operations.js';
import { BLOCK, checksumOk, cString, padding, parseNumber, parsePax } from './tar-format.js';

export interface TarEntry {
  type: 'file' | 'dir' | 'other';
  /** Path inside the archive without a trailing "/". */
  path: string;
  size: number;
  sha256?: string;
}

export interface TarScan {
  entries: TarEntry[];
  problems: string[];
  /** The archive ends with the tar end (two zero blocks). */
  ended: boolean;
  /** Size and SHA-256 of the archive file itself. */
  fileSize: number;
  fileSha256: string;
}

const MAXIMUM_PAX_SIZE = 1024 * 1024;

/** A push parser of the tar stream. */
class TarParser {
  entries: TarEntry[] = [];
  problems: string[] = [];
  ended = false;
  private buffer: Buffer = Buffer.alloc(0);
  private state: 'header' | 'pax' | 'data' | 'skip' | 'end2' | 'trailer' = 'header';
  private need = BLOCK;
  private paxSize = 0;
  private pax = new Map<string, string>();
  private current: TarEntry | null = null;
  private hash: Hash | null = null;
  private dataLeft = 0;
  private stopped = false;

  feed(chunk: Buffer): void {
    if (this.stopped) {
      return;
    }

    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    while (!this.stopped) {
      if (this.state === 'data') {
        if (!this.buffer.length) {
          return;
        }

        const take = Math.min(this.dataLeft, this.buffer.length);
        this.hash!.update(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.dataLeft -= take;

        if (this.dataLeft > 0) {
          return;
        }

        this.current!.sha256 = this.hash!.digest('hex');
        this.hash = null;
        this.state = 'skip';
        this.need = padding(this.current!.size).length;
        continue;
      }

      if (this.state === 'trailer') {
        if (this.buffer.some((byte) => byte !== 0)) {
          this.problems.push('non-zero data after the tar end');
          this.stopped = true;
        }

        this.buffer = Buffer.alloc(0);

        return;
      }

      if (this.buffer.length < this.need) {
        return;
      }

      const block = this.buffer.subarray(0, this.need);
      this.buffer = this.buffer.subarray(this.need);
      this.step(block);
    }
  }

  private step(block: Buffer): void {
    switch (this.state) {
      case 'skip':
        this.state = 'header';
        this.need = BLOCK;

        return;
      case 'end2':
        if (block.some((byte) => byte !== 0)) {
          this.problems.push('tar end: the second zero block is missing');
          this.stopped = true;

          return;
        }

        this.ended = true;
        this.state = 'trailer';

        return;
      case 'pax': {
        const parsed = parsePax(block.subarray(0, this.paxSize));

        if (!parsed) {
          this.problems.push(`invalid pax header (entry ${this.entries.length + 1})`);
          this.stopped = true;

          return;
        }

        this.pax = parsed;
        this.state = 'header';
        this.need = BLOCK;

        return;
      }
      case 'header':
        this.header(block);

        return;
      default:
        return;
    }
  }

  private header(header: Buffer): void {
    if (header.every((byte) => byte === 0)) {
      this.state = 'end2';
      this.need = BLOCK;

      return;
    }

    const entryNumber = this.entries.length + 1;

    if (!checksumOk(header) || cString(header, 257, 6) !== 'ustar') {
      this.problems.push(`invalid tar header (entry ${entryNumber}) - the archive is corrupted`);
      this.stopped = true;

      return;
    }

    const typeflag = String.fromCharCode(header[156]!);
    let size = parseNumber(header, 124, 12);

    if (typeflag === 'x') {
      if (!Number.isSafeInteger(size) || size < 0 || size > MAXIMUM_PAX_SIZE) {
        this.problems.push(`pax header too large (entry ${entryNumber})`);
        this.stopped = true;

        return;
      }

      this.state = 'pax';
      this.paxSize = size;
      this.need = size + padding(size).length;

      return;
    }

    const prefix = cString(header, 345, 155);
    const name = this.pax.get('path') ?? (prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100));

    if (this.pax.has('size')) {
      size = Number(this.pax.get('size'));
    }

    this.pax = new Map();

    // an exception here would be thrown from the gunzip "data" handler and crash the process
    if (!Number.isSafeInteger(size) || size < 0) {
      this.problems.push(`invalid entry size (entry ${entryNumber}) - the archive is corrupted`);
      this.stopped = true;

      return;
    }
    const path = name.replace(/\/$/, '');

    if (typeflag === '5') {
      this.entries.push({ type: 'dir', path, size: 0 });

      return;
    }

    const entry: TarEntry = { type: typeflag === '0' || typeflag === '\0' ? 'file' : 'other', path, size };
    this.entries.push(entry);
    this.current = entry;
    this.hash = createHash('sha256');
    this.dataLeft = size;

    if (size === 0) {
      entry.sha256 = this.hash.digest('hex');
      this.hash = null;

      return;
    }

    this.state = 'data';
  }

  finish(): void {
    if (this.stopped) {
      return;
    }

    if (this.state === 'data' || this.state === 'skip' || this.state === 'pax' || (this.state === 'header' && this.buffer.length)) {
      this.problems.push(`the archive is cut off${this.current ? ` at entry ${this.current.path}` : ''}`);
    }
  }
}

export async function scanTarGz(filePath: string, signal: AbortSignal, onBytes?: (byteCount: number) => void): Promise<TarScan> {
  const parser = new TarParser();
  const fileHash = createHash('sha256');
  let fileSize = 0;
  const gunzip = zlib.createGunzip();
  let gzipError: Error | null = null;
  gunzip.on('data', (chunk: Buffer) => parser.feed(chunk));

  // after an error the stream may never call pending write callbacks: wait for either
  const failed = new Promise<void>((resolve) =>
    gunzip.on('error', (error) => {
      gzipError ??= error;
      resolve();
    }),
  );

  const fileHandle = await fileSystemOperations.open(filePath, 'r');

  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);

    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, null);

      if (bytesRead === 0) {
        break;
      }

      fileHash.update(buffer.subarray(0, bytesRead));
      fileSize += bytesRead;
      onBytes?.(bytesRead);

      // after a gzip error the rest of the file is still read for its hash
      if (!gzipError) {
        const chunk = Buffer.from(buffer.subarray(0, bytesRead));
        await Promise.race([new Promise<void>((resolve) => gunzip.write(chunk, () => resolve())), failed]);
      }
    }
  } finally {
    await fileHandle.close();
  }

  if (!gzipError) {
    await Promise.race([
      new Promise<void>((resolve) => {
        gunzip.once('end', resolve);
        gunzip.end();
      }),
      failed,
    ]);
  }

  gunzip.destroy();
  parser.finish();
  const problems = [...parser.problems];

  if (gzipError) {
    problems.unshift(`the archive is corrupted (gzip: ${errorText(gzipError)}) - entries after this point cannot be checked`);
  }

  return { entries: parser.entries, problems, ended: parser.ended, fileSize, fileSha256: fileHash.digest('hex') };
}
