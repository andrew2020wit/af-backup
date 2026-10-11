// The log of a backup `<destination folder>/backup-<start time>.log` (docs/spec.md, "Running → Log"): the only place where
// the status of the backup is recorded. Every line is printed to the console at once; the lines produced before
// the log file is created (step 5 of "Task execution") are kept in memory and written to it first.

import { describeError } from '../utilities/errors.js';
import { escapeControl } from '../utilities/escape.js';
import { formatLocalDateTime } from '../utilities/format.js';
import type { ConsoleOutput } from './console-output.js';
import { fileSystemOperations, type FileHandle } from './file-system-operations.js';
import { writeAll } from './safe-file-system.js';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/** One log line: local time, level, text (control characters escaped). */
export function formatLogLine(time: Date, level: LogLevel, text: string): string {
  return `${formatLocalDateTime(time)} ${level.padEnd(5)} ${escapeControl(text)}`;
}

export class Log {
  /** Lines produced before the log file is created; null once it has been created. */
  private pendingLines: string[] | null = [];
  private fileHandle: FileHandle | null = null;
  private filePath = '';
  private queue: Promise<void> = Promise.resolve();
  /** The first file write error; after it lines go to the console only. */
  failure: string | null = null;
  /** The log file exists on disk (it stays even if the lines kept so far could not be written to it). */
  fileCreated = false;

  constructor(private readonly consoleOutput: ConsoleOutput) {}

  /**
   * Creates the log file ("new only") and writes the lines kept so far into it.
   * Throws if the file cannot be created or written; the lines stay console-only then.
   */
  async create(filePath: string): Promise<void> {
    const fileHandle = await fileSystemOperations.open(filePath, 'wx');
    this.fileCreated = true;
    const lines = this.pendingLines ?? [];
    this.pendingLines = null;
    this.filePath = filePath;

    try {
      await writeAll(fileHandle, lines.map((line) => `${line}\n`).join(''));
    } catch (error) {
      // the run does not start: the caller reports the error, later lines go to the console only
      await fileHandle.close().catch(() => {});

      throw error;
    }

    this.fileHandle = fileHandle;
  }

  /** Prints the line to the console at once and queues it for the file (or keeps it until the file is created). */
  write(level: LogLevel, text: string): void {
    const line = formatLogLine(new Date(), level, text);
    this.consoleOutput.line(level, line);

    if (this.pendingLines) {
      this.pendingLines.push(line);
    } else {
      this.queueWrite(`${line}\n`);
    }
  }

  /** Prints a line to the console only - for messages about the log itself. */
  consoleOnly(level: LogLevel, text: string): void {
    this.consoleOutput.line(level, formatLogLine(new Date(), level, text));
  }

  /** Waits until the queued lines are written. */
  async drain(): Promise<void> {
    await this.queue;
  }

  /** Writes the queued lines, flushes the file to disk and closes it. */
  async close(): Promise<void> {
    await this.drain();
    const fileHandle = this.fileHandle;
    this.fileHandle = null;

    if (!fileHandle) {
      return;
    }

    try {
      await fileHandle.sync();
    } catch (error) {
      this.fail(error);
    }

    await fileHandle.close().catch((error: unknown) => this.fail(error));
  }

  private queueWrite(text: string): void {
    this.queue = this.queue.then(async () => {
      const fileHandle = this.fileHandle;

      if (!fileHandle) {
        return;
      }

      try {
        await writeAll(fileHandle, text);
      } catch (error) {
        this.fail(error);
        await fileHandle.close().catch(() => {});
      }
    });
  }

  private fail(error: unknown): void {
    this.failure ??= `cannot write the log ${this.filePath}: ${describeError(error)}`;
    this.fileHandle = null;
  }
}
