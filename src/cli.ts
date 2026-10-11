// `af-backup [<destination folder>]`: arguments → run; invalid arguments are a "could not start" line in the console
// (docs/spec.md, "Running").

import { runBackup } from './run-pipeline.js';
import { EXIT_CANNOT_START } from './utilities/errors.js';
import { formatLogLine } from './services/log.js';
import { checkArguments, destinationArgument } from './utilities/arguments.js';
import type { CliContext } from './interfaces/cli-context.interface.js';

export async function runCli(argv: readonly string[], context: CliContext): Promise<number> {
  const problem = checkArguments(argv);

  if (problem === null) {
    return runBackup(destinationArgument(argv), context);
  }

  context.consoleOutput.line('ERROR', formatLogLine(new Date(), 'ERROR', `Backup could not start, code ${EXIT_CANNOT_START}: ${problem}`));

  return EXIT_CANNOT_START;
}
