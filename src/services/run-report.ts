// Run report: counts errors (level 3) and warnings (level 4) of a run and passes every event to the log
// (docs/spec.md, "Running → Log", "Error handling").

import type { LogLevel } from './log.js';

export interface ReportEvent {
  level: LogLevel;
  text: string;
}

export type EventSink = (event: ReportEvent) => void;

export class RunReport {
  errors = 0;
  warnings = 0;

  constructor(private readonly sink: EventSink) {}

  info(text: string): void {
    this.sink({ level: 'INFO', text });
  }

  warn(text: string): void {
    this.warnings++;
    this.sink({ level: 'WARN', text });
  }

  /** A level 3 error: the item is skipped, the backup will not finish successfully. */
  error(text: string): void {
    this.errors++;
    this.sink({ level: 'ERROR', text });
  }

  /** An event that is not counted (for example, a level 2 error or a final line). */
  log(level: LogLevel, text: string): void {
    this.sink({ level, text });
  }
}
