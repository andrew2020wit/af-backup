// `af-backup <destination folder>`: steps 0-8 of "Task execution" (docs/spec.md). The status of the backup is recorded
// only in its log `backup-<start time>.log`: the backup data folder `backup-data-<start time>` is created at the start
// and never renamed.

import * as path from 'node:path';
import { backupNames, type BackupNames } from './utilities/destination-layout.js';
import type { CliContext } from './interfaces/cli-context.interface.js';
import {
  EXIT_CANNOT_START,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_WITH_ERRORS,
  FatalError,
  InterruptedError,
  StartError,
  describeError,
  errorCode,
  fatalFrom,
  throwIfAborted,
} from './utilities/errors.js';
import { fileSystemOperations } from './services/file-system-operations.js';
import { fsyncDirectory } from './services/safe-file-system.js';
import { formatBytes, formatDuration, plural } from './utilities/format.js';
import { Log } from './services/log.js';
import { environmentDescription } from './utilities/platform.js';
import { archiveSource } from './services/archive-source.js';
import { copySource, type CopyContext, type CopyProgress } from './services/copier.js';
import { checkDestination } from './services/destination.js';
import { CopiedItems } from './services/copied-items.js';
import { maskSummary } from './services/file-list.js';
import { notEnoughSpace, prepareRun, type Prepared } from './services/prepare.js';
import { RunReport } from './services/run-report.js';
import { verifyBackupFolder, type VerifyOptions, type VerifyResult } from './services/verifier.js';

export async function runBackup(destinationArgument: string, context: CliContext): Promise<number> {
  const startTime = context.now();
  const destinationFolder = path.resolve(destinationArgument);
  const names = backupNames(destinationFolder, startTime);
  const log = new Log(context.consoleOutput);

  // Step 0: the "Backup started" line - kept in memory until the log file is created at step 5
  log.write('INFO', `Backup started: destination folder ${destinationFolder}; ${environmentDescription(startTime)}`);

  let code: number;

  try {
    code = await prepareAndRun(destinationFolder, names, startTime, log, context);
  } finally {
    await log.close();

    if (log.failure) {
      log.consoleOnly('ERROR', `${log.failure} - the lines above may be missing from the log`);
    }
  }

  // A log write or flush error after the final line is a level 2 error too: the success line may not be on disk
  if (code === EXIT_OK && log.failure) {
    log.consoleOnly('ERROR', `Backup finished WITH ERRORS: ${names.dataFolder} is not a valid backup (the log cannot be written), code ${EXIT_WITH_ERRORS}`);

    return EXIT_WITH_ERRORS;
  }

  return code;
}

async function prepareAndRun(destinationFolder: string, names: BackupNames, startTime: Date, log: Log, context: CliContext): Promise<number> {
  const report = new RunReport((event) => log.write(event.level, event.text));
  let prepared: Prepared;

  try {
    prepared = await prepareRun({ destinationFolder, backupNames: names, report, signal: context.signal });
    const spaceProblem = notEnoughSpace(destinationFolder, prepared.space);

    // a backup does not start without enough space (level 1)
    if (spaceProblem) {
      throw new StartError(spaceProblem);
    }
  } catch (error) {
    return cannotStart(error, log);
  }

  return new Execution(prepared, destinationFolder, names, startTime, report, log, context).run();
}

/**
 * The final line of a run that could not start (level 1 error or an interrupt before the backup data folder exists):
 * to the console only, unless the log file has already been created.
 */
function cannotStart(error: unknown, log: Log): number {
  if (error instanceof InterruptedError) {
    log.write('ERROR', `Backup could not start: interrupted, code ${EXIT_INTERRUPTED}`);

    return EXIT_INTERRUPTED;
  }

  const messages = error instanceof StartError ? error.messages : [`unexpected error: ${describeError(error)}`];
  log.write('ERROR', `Backup could not start, code ${EXIT_CANNOT_START}: ${messages.join('; ')}`);

  return EXIT_CANNOT_START;
}

/** For an item that appeared after the checks of step 5: most likely created by a concurrent run. */
function anotherRunHint(error: unknown): string {
  return errorCode(error) === 'EEXIST' ? ' (another run with this destination folder may have just started)' : '';
}

class Execution {
  private readonly copiedItems = new CopiedItems();
  private verifyResult: VerifyResult | null = null;
  private readonly progress: CopyProgress = { files: 0, bytes: 0 };
  private readonly dataFolder: string;

  constructor(
    private readonly prepared: Prepared,
    private readonly destinationFolder: string,
    private readonly names: BackupNames,
    private readonly startTime: Date,
    private readonly report: RunReport,
    private readonly log: Log,
    private readonly context: CliContext,
  ) {
    this.dataFolder = names.dataFolder;
  }

  async run(): Promise<number> {
    try {
      await this.createLogAndDataFolder();
    } catch (error) {
      return cannotStart(error, this.log);
    }

    let fatal: FatalError | null = null;
    let interrupted = false;

    try {
      await this.copyAndVerify();
      // an interrupt that came after the last check
      throwIfAborted(this.context.signal);
    } catch (error) {
      if (error instanceof InterruptedError) {
        interrupted = true;
      } else {
        fatal = error instanceof FatalError ? error : new FatalError(`unexpected error: ${describeError(error)}`);
      }
    }

    this.context.consoleOutput.clearProgress();

    if (fatal) {
      this.report.error(`Fatal error, the backup is stopped: ${fatal.message}`);
    }

    // Step 8: the summary and the final line with the status
    const code = interrupted ? EXIT_INTERRUPTED : this.report.errors === 0 ? EXIT_OK : EXIT_WITH_ERRORS;
    this.writeSummary();
    const backup = this.dataFolder;

    if (code === EXIT_OK) {
      this.log.write('INFO', `Backup finished successfully: ${backup}, code ${code}`);
    } else if (code === EXIT_INTERRUPTED) {
      this.log.write('ERROR', `Backup INTERRUPTED: ${backup} is not a valid backup, code ${code}`);
    } else {
      this.log.write('ERROR', `Backup finished WITH ERRORS: ${backup} is not a valid backup (errors ${this.report.errors}), code ${code}`);
    }

    return code;
  }

  // Step 5: the destination folder check again, the log file and the backup data folder (both "new only")
  private async createLogAndDataFolder(): Promise<void> {
    // building the file list may have taken a long time
    await checkDestination(this.destinationFolder, this.names);
    throwIfAborted(this.context.signal);
    const logFile = this.names.logFile;

    try {
      await this.log.create(logFile);
    } catch (error) {
      if (this.log.fileCreated) {
        throw new StartError(
          `the log ${logFile} was created but cannot be written: ${describeError(error)} - ` +
            'the file stays (it is not a valid backup)',
        );
      }

      throw new StartError(`cannot create the log ${logFile}: ${describeError(error)}${anotherRunHint(error)}`);
    }

    try {
      await fileSystemOperations.mkdir(this.dataFolder);
    } catch (error) {
      throw new StartError(`cannot create the backup data folder ${this.dataFolder}: ${describeError(error)}${anotherRunHint(error)}`);
    }

    this.log.write('INFO', `Backup data folder created: ${this.dataFolder}`);
  }

  private checkLog(): void {
    if (this.log.failure) {
      throw new FatalError(this.log.failure);
    }
  }

  // Steps 6-7
  private async copyAndVerify(): Promise<void> {
    const { signal, consoleOutput } = this.context;
    const list = this.prepared.list;
    const dataFolder = this.dataFolder;

    const copyContext: CopyContext = {
      backupRoot: dataFolder,
      copiedItems: this.copiedItems,
      report: this.report,
      signal,
      progress: this.progress,
      onProgress: () =>
        consoleOutput.progress(`Copying: ${this.progress.files}/${list.totalFiles} files, ${formatBytes(this.progress.bytes)} / ${formatBytes(list.totalBytes)}`),
      checkLog: () => this.checkLog(),
    };

    // Step 6: copying
    for (const sourceList of list.sources) {
      throwIfAborted(signal);

      if (sourceList.source.compress) {
        await archiveSource(sourceList, copyContext);
      } else {
        await copySource(sourceList, copyContext);
      }

      this.checkLog();
    }

    consoleOutput.clearProgress();

    try {
      await fsyncDirectory(dataFolder);
      await fsyncDirectory(this.destinationFolder);
    } catch (error) {
      throw fatalFrom('cannot flush the backup folder to disk', error);
    }

    this.checkLog();

    // Step 7: verification
    const verifyProgress = { files: 0, bytes: 0 };

    const verifyOptions: VerifyOptions = {
      signal,
      progress: verifyProgress,
      onProgress: () =>
        consoleOutput.progress(
          `Verifying: ${verifyProgress.files}/${this.progress.files} files, ${formatBytes(verifyProgress.bytes)} / ${formatBytes(this.progress.bytes)}`,
        ),
    };

    this.verifyResult = await verifyBackupFolder(dataFolder, this.copiedItems.items, this.copiedItems.leftovers, verifyOptions);
    consoleOutput.clearProgress();

    for (const mismatch of this.verifyResult.problems) {
      this.report.error(`Verification: ${mismatch}`);
    }

    // unfinished files that could not be deleted are explained by the warnings written while copying
    const unexplained = this.verifyResult.problems.length - this.verifyResult.leftovers;

    if (unexplained > 0) {
      this.report.log('ERROR', `verification found ${plural(unexplained, 'mismatch', 'mismatches')} right after copying - the destination disk may be faulty`);
    }

    this.checkLog();
  }

  private writeSummary(): void {
    const list = this.prepared.list;
    const excluded = list.sources.reduce((total, sourceList) => total + sourceList.excluded, 0);

    const verification = this.verifyResult
      ? this.verifyResult.problems.length === 0
        ? 'OK'
        : plural(this.verifyResult.problems.length, 'mismatch', 'mismatches')
      : 'not done';

    this.log.write(
      'INFO',
      `Summary: copied ${this.copiedItems.files} files / ${this.copiedItems.directories} folders / ${formatBytes(this.copiedItems.bytes)}; ` +
        `excluded ${excluded}${list.masks.length ? ` (${maskSummary(list.masks)})` : ''}; warnings ${this.report.warnings}; errors ${this.report.errors}; ` +
        `verification: ${verification}; duration ${formatDuration(this.context.now().getTime() - this.startTime.getTime())}`,
    );
  }
}
