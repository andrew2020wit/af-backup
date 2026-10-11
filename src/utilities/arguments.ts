// Command line: `af-backup [--compute-size] [<destination folder>]` - at most one destination folder and the only option
// `--compute-size`, in any order; without a folder the destination folder is the current folder (docs/spec.md, "Running").

export const COMPUTE_SIZE_OPTION = '--compute-size';

const USAGE =
  'usage: af-backup [--compute-size] [<destination folder>] (an existing folder with the task file af-backup-task.json; the current folder if omitted)';

export type ParsedCommandLine = { ok: true; destinationFolder: string; computeSize: boolean } | { ok: false; problem: string };

export function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  let destinationFolder: string | undefined;
  let computeSize = false;

  for (const argument of argv) {
    if (argument === '') {
      return { ok: false, problem: `an empty argument - ${USAGE}` };
    }

    if (argument === COMPUTE_SIZE_OPTION) {
      if (computeSize) {
        return { ok: false, problem: `${COMPUTE_SIZE_OPTION} is given twice - ${USAGE}` };
      }

      computeSize = true;
      continue;
    }

    if (argument.startsWith('-')) {
      return { ok: false, problem: `unknown option: ${argument} (the only option is ${COMPUTE_SIZE_OPTION}) - ${USAGE}` };
    }

    if (destinationFolder !== undefined) {
      return { ok: false, problem: `at most one destination folder is expected, got ${destinationFolder} and ${argument} - ${USAGE}` };
    }

    destinationFolder = argument;
  }

  return { ok: true, destinationFolder: destinationFolder ?? '.', computeSize };
}
