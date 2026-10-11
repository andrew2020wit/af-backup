/**
 * Content of a task file `af-backup-task.json` (docs/spec.md, "Task" → "Fields"). The destination is not a field:
 * it is the folder the task file lies in.
 */
export interface Task {
  /** Identifies the file as an af-backup task. */
  jsonType: 'af-backup-task';
  /** Format version; bumped on incompatible changes. */
  version: 1;
  description?: string;
  /** Exclusion masks for all sources. */
  exclude?: string[];
  sources: TaskSource[];
}

export interface TaskSource {
  /** Absolute path of a folder or a file. */
  path: string;
  /** Subfolder name in the backup; default - the last part of the path (required for a drive root). */
  name?: string;
  /** Exclusion masks for this source. */
  exclude?: string[];
  /** Compress the source into `<name>.tar.gz`; default false. */
  compress?: boolean;
}
