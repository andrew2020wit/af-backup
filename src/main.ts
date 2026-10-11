#!/usr/bin/env node
// Entry point: arguments, command, exit code, signals.

import { EXIT_INTERRUPTED } from './utilities/errors.js';
import { runCli } from './cli.js';
import { ConsoleOutput } from './services/console-output.js';

const abortController = new AbortController();
const consoleOutput = new ConsoleOutput();

// The first signal stops gracefully; a second one while the stop is still in progress exits at once
// (docs/spec.md, "Stopping by the user").
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

if (process.platform === 'win32') {
  signals.push('SIGBREAK');
}

for (const signal of signals) {
  process.on(signal, () => {
    if (abortController.signal.aborted) {
      consoleOutput.line('ERROR', 'stopped immediately (second interrupt)');
      process.exit(EXIT_INTERRUPTED);
    }

    consoleOutput.line('WARN', 'interrupting... (press Ctrl+C again to exit immediately)');
    abortController.abort();
  });
}

const code = await runCli(process.argv.slice(2), { consoleOutput, signal: abortController.signal, now: () => new Date() });
// Not process.exit(): it may cut off output still being written to a pipe.
process.exitCode = code;
