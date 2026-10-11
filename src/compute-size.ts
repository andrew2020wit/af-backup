// `af-backup --compute-size [<destination folder>]`: how much a backup would copy, without making it
// (docs/spec.md, "Computing the size"). The checks and the file list are those of steps 1-4 of a backup;
// nothing is written: the lines go to the console only, in the format of the log lines.

import * as path from 'node:path';
import type { CliContext } from './interfaces/cli-context.interface.js';
import { EXIT_CANNOT_START, EXIT_INTERRUPTED, EXIT_OK, EXIT_WITH_ERRORS, InterruptedError, StartError, describeError } from './utilities/errors.js';
import { formatBytes, plural } from './utilities/format.js';
import { environmentDescription } from './utilities/platform.js';
import { formatLogLine, type LogLevel } from './services/log.js';
import { maskSummary, type SourceList } from './services/file-list.js';
import { notEnoughSpace, prepareRun, type Prepared } from './services/prepare.js';
import { RunReport } from './services/run-report.js';

export async function computeSize(destinationArgument: string, context: CliContext): Promise<number> {
  const startTime = context.now();
  const destinationFolder = path.resolve(destinationArgument);
  const print = (level: LogLevel, text: string) => context.consoleOutput.line(level, formatLogLine(new Date(), level, text));
  print('INFO', `Size computation started: destination folder ${destinationFolder}; ${environmentDescription(startTime)}`);
  const report = new RunReport((event) => print(event.level, event.text));
  let prepared: Prepared;

  try {
    prepared = await prepareRun({ destinationFolder, report, signal: context.signal });
  } catch (error) {
    if (error instanceof InterruptedError) {
      print('ERROR', `Size computation INTERRUPTED, code ${EXIT_INTERRUPTED}`);

      return EXIT_INTERRUPTED;
    }

    const messages = error instanceof StartError ? error.messages : [`unexpected error: ${describeError(error)}`];
    print('ERROR', `Size computation could not start, code ${EXIT_CANNOT_START}: ${messages.join('; ')}`);

    return EXIT_CANNOT_START;
  }

  const { list, space } = prepared;

  for (const sourceList of list.sources) {
    print('INFO', sourceLine(sourceList));
  }

  const folders = list.sources.reduce((total, sourceList) => total + folderCount(sourceList), 0);
  const excluded = list.sources.reduce((total, sourceList) => total + sourceList.excluded, 0);
  const spaceText = space ? `required about ${formatBytes(space.required)} with a margin, available ${formatBytes(space.available)}` : 'free space unknown';

  print(
    'INFO',
    `Total: ${plural(list.totalFiles, 'file')} / ${plural(folders, 'folder')} / ${formatBytes(list.totalBytes)}; ` +
      `excluded ${excluded}${list.masks.length ? ` (${maskSummary(list.masks)})` : ''}; ${spaceText}`,
  );

  const spaceProblem = notEnoughSpace(destinationFolder, space);

  // the backup would not start
  if (spaceProblem) {
    report.error(spaceProblem);
  }

  if (report.errors === 0) {
    print('INFO', `Size computation finished successfully, code ${EXIT_OK}`);

    return EXIT_OK;
  }

  print('ERROR', `Size computation finished WITH ERRORS (errors ${report.errors}), code ${EXIT_WITH_ERRORS}`);

  return EXIT_WITH_ERRORS;
}

/** Folders inside the source (the source folder itself is not counted). */
function folderCount(sourceList: SourceList): number {
  return sourceList.entries.filter((entry) => entry.type === 'dir').length;
}

function sourceLine(sourceList: SourceList): string {
  const label = `Source "${sourceList.source.name}" (${sourceList.source.path})`;

  if (sourceList.kind === 'unusable') {
    return `${label}: not available (see the error above)`;
  }

  const compressed = sourceList.source.compress ? ' (compressed: the archive will be smaller)' : '';

  return (
    `${label}: ${plural(sourceList.files, 'file')} / ${plural(folderCount(sourceList), 'folder')} / ${formatBytes(sourceList.bytes)}; ` +
    `excluded ${sourceList.excluded}${compressed}`
  );
}
