import type { ConsoleOutput } from '../services/console-output.js';

/** What a command gets from the CLI: console output, the stop signal and the clock. */
export interface CliContext {
  consoleOutput: ConsoleOutput;
  /** Aborted on Ctrl+C or a termination signal. */
  signal: AbortSignal;
  /** The current time: the start time of a run names its backup (tests set it to get known names). */
  now: () => Date;
}
