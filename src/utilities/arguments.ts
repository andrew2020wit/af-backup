// Command line: `af-backup [<destination folder>]` - at most one argument, no options; without an argument
// the destination folder is the current folder (docs/spec.md, "Running").

const USAGE =
  'usage: af-backup [<destination folder>] (an existing folder with the task file af-backup-task.json; the current folder if omitted)';

/** Returns an error text, or null if the arguments are at most one destination folder. */
export function checkArguments(argv: readonly string[]): string | null {
  if (argv.length > 1) {
    return `at most one argument is expected, got ${argv.length} - ${USAGE}`;
  }

  const destinationFolder = argv[0];

  if (destinationFolder === undefined) {
    return null;
  }

  if (destinationFolder === '') {
    return `the destination folder is empty - ${USAGE}`;
  }

  if (destinationFolder.startsWith('-')) {
    return `there are no options: ${destinationFolder} - ${USAGE}`;
  }

  return null;
}

/** The destination folder argument: the given one, or the current folder without an argument. */
export function destinationArgument(argv: readonly string[]): string {
  return argv[0] ?? '.';
}
