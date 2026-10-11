// .tar.gz writer: each entry is a separate gzip member, so an unfinished entry is rolled back by truncating
// the archive to the member boundary (docs/spec.md, "Compression" → "Errors and retries").

import { createHash, type Hash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { fileSystemOperations, type FileHandle } from './file-system-operations.js';
import { writeAll } from './safe-file-system.js';
import { entryHeaders, padding, tarEnd } from './tar-format.js';

/** Failure of the archive file itself: writing, truncation (rollback). */
export class ArchiveWriteError extends Error {
  constructor(
    readonly what: string,
    override readonly cause: unknown,
  ) {
    super(what);
  }
}

export class TarGzWriter {
  /** Current archive size = the boundary between gzip members. */
  private position = 0;
  private hash: Hash = createHash('sha256');

  private constructor(private readonly fileHandle: FileHandle) {}

  /** Creates the archive file ("new only"). */
  static async create(filePath: string): Promise<TarGzWriter> {
    return new TarGzWriter(await fileSystemOperations.open(filePath, 'wx'));
  }

  get size(): number {
    return this.position;
  }

  private async writeRaw(chunk: Buffer): Promise<void> {
    try {
      await writeAll(this.fileHandle, chunk, this.position);
    } catch (error) {
      throw new ArchiveWriteError('write error in the archive', error);
    }

    this.position += chunk.length;
    this.hash.update(chunk);
  }

  private async writeMember(data: Buffer): Promise<void> {
    await this.writeRaw(zlib.gzipSync(data));
  }

  async addDirectory(relativePath: string, mtimeNs: bigint): Promise<void> {
    await this.atomically(() => this.writeMember(entryHeaders(relativePath, 'dir', 0, mtimeNs)));
  }

  /**
   * Writes a file entry as one gzip member. `produce` gets `begin(size, mtimeNs)` (headers, called once
   * the size is known) and `write(chunk)`; any failure rolls the archive back to the member boundary.
   */
  async addFile<T>(
    relativePath: string,
    produce: (sink: { begin: (size: number, mtimeNs: bigint) => Promise<void>; write: (chunk: Buffer) => Promise<void> }) => Promise<T>,
  ): Promise<T> {
    return this.atomically(async () => {
      const gzip = zlib.createGzip();
      const compressedChunks: Buffer[] = [];
      let gzipError: Error | null = null;
      gzip.on('data', (chunk: Buffer) => compressedChunks.push(chunk));
      gzip.on('error', (error) => (gzipError = error));

      const drain = async () => {
        for (const chunk of compressedChunks.splice(0)) {
          await this.writeRaw(chunk);
        }
      };

      const push = async (buffer: Buffer) => {
        await new Promise<void>((resolve, reject) => gzip.write(buffer, (error) => (error ? reject(error) : resolve())));
        await drain();
      };

      let size = 0;
      let declared = -1;

      try {
        const result = await produce({
          begin: async (declaredSize, mtimeNs) => {
            declared = declaredSize;
            await push(entryHeaders(relativePath, 'file', declaredSize, mtimeNs));
          },
          write: async (chunk) => {
            size += chunk.length;

            if (size > declared) {
              throw new Error('internal: more data than declared'); // caught as a change by the caller
            }

            await push(chunk);
          },
        });

        if (size !== declared) {
          throw new Error('internal: less data than declared');
        }

        await push(padding(size));

        const ended = new Promise<void>((resolve, reject) => {
          gzip.once('end', resolve);
          gzip.once('error', reject);
        });

        gzip.end();
        await ended;
        await drain();

        if (gzipError) {
          throw gzipError;
        }

        return result;
      } finally {
        gzip.destroy();
      }
    });
  }

  /** Runs a write; on any failure truncates the archive back to the member boundary (rollback). */
  private async atomically<T>(write: () => Promise<T>): Promise<T> {
    const boundary = this.position;
    const hashAtBoundary = this.hash.copy();

    try {
      return await write();
    } catch (error) {
      try {
        await this.fileHandle.truncate(boundary);
      } catch (truncateError) {
        throw new ArchiveWriteError('cannot roll back the archive (truncation failed)', truncateError);
      }

      this.position = boundary;
      this.hash = hashAtBoundary;
      throw error;
    }
  }

  /** Writes the tar end (a separate member), flushes the archive to disk and closes it. */
  async finish(): Promise<{ size: number; sha256: string }> {
    await this.writeMember(tarEnd());

    try {
      await this.fileHandle.sync();
    } catch (error) {
      throw new ArchiveWriteError('cannot flush the archive to disk', error);
    }

    await this.close();

    return { size: this.position, sha256: this.hash.digest('hex') };
  }

  async close(): Promise<void> {
    await this.fileHandle.close().catch(() => {});
  }
}
