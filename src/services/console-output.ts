// Console output (docs/spec.md, "Running → Console output"): the log lines - `ERROR` and `WARN` to stderr,
// `INFO` to stdout; in a terminal also a progress line, which is not logged.

export interface OutputStream {
  write(text: string): unknown;
  isTTY?: boolean;
}

export class ConsoleOutput {
  readonly interactive: boolean;
  private progressShown = false;
  private lastProgressAt = 0;

  constructor(
    private readonly stdout: OutputStream = process.stdout,
    private readonly stderr: OutputStream = process.stderr,
  ) {
    this.interactive = stdout.isTTY === true;
  }

  /** Prints a line: `INFO` to stdout, `WARN` and `ERROR` to stderr. */
  line(level: 'INFO' | 'WARN' | 'ERROR', text: string): void {
    this.clearProgress();
    (level === 'INFO' ? this.stdout : this.stderr).write(`${text}\n`);
  }

  /** A progress line, only in a terminal; throttled. */
  progress(text: string): void {
    if (!this.interactive) {
      return;
    }

    const now = Date.now();

    if (now - this.lastProgressAt < 200) {
      return;
    }

    this.lastProgressAt = now;
    this.stdout.write(`\r\x1b[2K${text}`);
    this.progressShown = true;
  }

  clearProgress(): void {
    if (!this.progressShown) {
      return;
    }

    this.stdout.write('\r\x1b[2K');
    this.progressShown = false;
  }
}

/** Collects output in memory (tests). */
export class MemoryStream implements OutputStream {
  text = '';
  isTTY = false;

  write(text: string): boolean {
    this.text += text;

    return true;
  }
}
