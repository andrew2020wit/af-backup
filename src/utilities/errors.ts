// Error model (docs/spec.md, "Error handling"; docs/how-it-works.md, "Error levels").
//
// Level 1 - StartError: the task cannot start, no backup folder is created, exit code 2.
// Level 2 - FatalError: the destination as a whole failed, copying/verification stops, the backup finishes with errors.
// Level 3 - not an exception: an item error recorded in the run report, work continues.
// Level 4 - not an exception: a warning.
// Ctrl+C / termination signal - InterruptedError, exit code 3.

export class StartError extends Error {
  readonly messages: string[];

  constructor(messages: string | string[]) {
    const list = Array.isArray(messages) ? messages : [messages];
    super(list.join('; '));
    this.name = 'StartError';
    this.messages = list;
  }
}

export class FatalError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(code ? `${message} (${code})` : message);
    this.name = 'FatalError';
    this.code = code;
  }
}

export class InterruptedError extends Error {
  constructor() {
    super('interrupted by the user');
    this.name = 'InterruptedError';
  }
}

export const EXIT_OK = 0;
export const EXIT_WITH_ERRORS = 1;
export const EXIT_CANNOT_START = 2;
export const EXIT_INTERRUPTED = 3;

export function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }

  return undefined;
}

/** Error text without the OS error code. */
export function errorText(error: unknown): string {
  if (error instanceof FatalError || error instanceof StartError) {
    return error.message;
  }

  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);

  // Node.js messages look like "EBUSY: resource busy or locked, open 'C:\...'": keep the short part
  return code && message.startsWith(`${code}: `) ? message.slice(code.length + 2).replace(/, \w+ '.*'$/s, '') : message;
}

/** Error text with the OS error code next to it, e.g. "resource busy or locked (EBUSY)". */
export function describeError(error: unknown): string {
  if (error instanceof FatalError || error instanceof StartError) {
    return error.message;
  }

  const code = errorCode(error);

  return code ? `${errorText(error)} (${code})` : errorText(error);
}

/** A level 2 error caused by an OS error: "<what>: <text> (<code>)". */
export function fatalFrom(what: string, error: unknown): FatalError {
  if (error instanceof FatalError) {
    return error;
  }

  return new FatalError(`${what}: ${errorText(error)}`, errorCode(error));
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new InterruptedError();
  }
}
