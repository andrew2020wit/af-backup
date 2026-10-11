// Copying a compressed source into `<name>.tar.gz` (docs/spec.md, "Compression").
//
// Before each entry the archive size (the gzip member boundary) is remembered; a failed entry is rolled back
// by truncation, so only complete entries remain. Errors are handled as for an uncompressed source.

import * as path from 'node:path';
import { ArchiveWriteError, TarGzWriter } from './tar-writer.js';
import { FatalError, errorCode, fatalFrom, throwIfAborted } from '../utilities/errors.js';
import { plural } from '../utilities/format.js';
import { escapeControl } from '../utilities/escape.js';
import { ARCHIVE_SUFFIX } from './names.js';
import { ItemError, SourceUnavailable, destinationFailure, readSourceFile, sourceRootFor, withFileRetries, type CopyContext } from './copier.js';
import type { SourceList } from './file-list.js';

/** The archive exceeded the destination file system limit (EFBIG): archiving of the source stops. */
class ArchiveLimit extends Error {}

/** An archive write or truncation error: EFBIG - the file system limit (level 3), otherwise level 2. */
function archiveFailure(error: ArchiveWriteError): Error {
  return errorCode(error.cause) === 'EFBIG' ? new ArchiveLimit(error.what) : fatalFrom(error.what, error.cause);
}

export async function archiveSource(list: SourceList, context: CopyContext): Promise<void> {
  if (list.kind === 'unusable') {
    return;
  }

  const name = list.source.name;
  const archiveName = name + ARCHIVE_SUFFIX;
  const archivePath = path.join(context.backupRoot, archiveName);
  let writer: TarGzWriter;

  try {
    writer = await TarGzWriter.create(archivePath);
  } catch (error) {
    const failure = await destinationFailure(error, `cannot create the archive ${archiveName}`, context.backupRoot);

    if (failure instanceof FatalError) {
      throw failure;
    }

    context.report.error(`${escapeControl(archiveName)}: ${failure.message}; the source is not copied (${plural(list.files, 'file')})`);

    return;
  }

  let finished = false;

  try {
    const sourceRoot = sourceRootFor(list);
    const entries = list.entries;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      throwIfAborted(context.signal);
      context.checkLog();
      const shown = escapeControl(`${archiveName}/${entry.relativePath}`);

      try {
        if (entry.type === 'dir') {
          await writer.addDirectory(entry.relativePath, entry.mtimeNs);
          context.copiedItems.addDirectory({ type: 'dir', in: archiveName, path: entry.relativePath });
          continue;
        }

        await withFileRetries(shown, sourceRoot, context, async () => {
          let declared = 0;
          let written = 0;

          try {
            const readResult = await writer.addFile(entry.relativePath, (sink) =>
              readSourceFile(entry, context.signal, {
                begin: async (size, mtimeNs) => {
                  declared = size;
                  await sink.begin(size, mtimeNs);
                },
                write: async (chunk) => {
                  if (written + chunk.length > declared) {
                    throw new ItemError('the file changed while being copied', true, false);
                  }

                  await sink.write(chunk);
                  written += chunk.length;
                  context.progress.bytes += chunk.length;
                  context.onProgress();
                },
              }),
            );

            context.copiedItems.addFile({ type: 'file', in: archiveName, path: entry.relativePath, size: readResult.size, sha256: readResult.sha256 });
          } catch (error) {
            context.progress.bytes -= written;
            throw error;
          }
        });
      } catch (error) {
        const failure = error instanceof ArchiveWriteError ? archiveFailure(error) : error;

        if (!(failure instanceof SourceUnavailable || failure instanceof ArchiveLimit)) {
          throw failure;
        }

        const left = plural(entries.slice(i).filter((other) => other.type === 'file').length, 'file');

        context.report.error(
          failure instanceof SourceUnavailable
            ? `source "${name}" (${list.source.path}) became unavailable: ${failure.message}; ${left} not archived`
            : `${escapeControl(archiveName)}: the archive exceeded the destination file system limit (EFBIG); archiving stopped, ${left} not archived`,
        );
        break;
      }
    }

    let result;

    try {
      result = await writer.finish();
    } catch (error) {
      if (error instanceof ArchiveWriteError && errorCode(error.cause) === 'EFBIG') {
        context.report.error(`${escapeControl(archiveName)}: the tar end does not fit into the destination file system limit (EFBIG) - the archive is incomplete`);
        context.copiedItems.addIncompleteArchive(archiveName);

        return;
      }

      throw error instanceof ArchiveWriteError ? fatalFrom(error.what, error.cause) : error;
    }

    finished = true;
    context.copiedItems.addArchive({ type: 'archive', path: archiveName, size: result.size, sha256: result.sha256 });
  } finally {
    if (!finished) {
      await writer.close();
    }
  }
}
