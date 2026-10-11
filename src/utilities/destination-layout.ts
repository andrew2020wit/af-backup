// What lies in the destination folder (docs/spec.md, "Destination folder"): the task file created by the user
// and the backups created by runs - a backup data folder and a log per run, named by the start time of the run.

import * as path from 'node:path';

export const TASK_FILE_NAME = 'af-backup-task.json';

/** The backup data folder and the log of one run. */
export interface BackupNames {
  dataFolderName: string;
  logFileName: string;
  dataFolder: string;
  logFile: string;
}

export function taskFilePath(destinationFolder: string): string {
  return path.join(destinationFolder, TASK_FILE_NAME);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** The local start time to the second, "2026-10-04-11-20-15" (yyyy-mm-dd-HH-MM-SS). */
export function startTimeStamp(startTime: Date): string {
  return [
    pad(startTime.getFullYear(), 4),
    pad(startTime.getMonth() + 1),
    pad(startTime.getDate()),
    pad(startTime.getHours()),
    pad(startTime.getMinutes()),
    pad(startTime.getSeconds()),
  ].join('-');
}

/** `backup-data-<start time>` and `backup-<start time>.log` in the destination folder. */
export function backupNames(destinationFolder: string, startTime: Date): BackupNames {
  const stamp = startTimeStamp(startTime);
  const dataFolderName = `backup-data-${stamp}`;
  const logFileName = `backup-${stamp}.log`;

  return {
    dataFolderName,
    logFileName,
    dataFolder: path.join(destinationFolder, dataFolderName),
    logFile: path.join(destinationFolder, logFileName),
  };
}
