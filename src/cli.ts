// `af-backup [--compute-size] [<destination folder>]`: arguments → a backup or a size computation; invalid arguments
// are a "could not start" line in the console (docs/spec.md, "Running").

import { runBackup } from './run-pipeline.js';
import { computeSize } from './compute-size.js';
import { EXIT_CANNOT_START } from './utilities/errors.js';
import { formatLogLine } from './services/log.js';
import { COMPUTE_SIZE_OPTION, parseCommandLine } from './utilities/arguments.js';
import type { CliContext } from './interfaces/cli-context.interface.js';

export async function runCli(argv: readonly string[], context: CliContext): Promise<number> {
  const commandLine = parseCommandLine(argv);

  if (commandLine.ok) {
    return commandLine.computeSize ? computeSize(commandLine.destinationFolder, context) : runBackup(commandLine.destinationFolder, context);
  }

  const what = argv.includes(COMPUTE_SIZE_OPTION) ? 'Size computation' : 'Backup';
  context.consoleOutput.line('ERROR', formatLogLine(new Date(), 'ERROR', `${what} could not start, code ${EXIT_CANNOT_START}: ${commandLine.problem}`));

  return EXIT_CANNOT_START;
}
