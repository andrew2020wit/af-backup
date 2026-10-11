# AF Backup

A simple tool for personal backups, designed with reliability as the top priority. Console, cross-platform
(Windows, Linux, macOS), written in TypeScript for Node.js. Provided as is, without any warranty
(see "License and disclaimer").

## Key points

How af-backup is designed - these are design goals, not guarantees:

- **A backup is a plain folder of files.** Restoring does not need the tool itself:
  files are simply copied back. Compressed sources are standard `.tar.gz`: on Windows it is better
  to extract them with 7-Zip, on macOS and Linux - with the built-in `tar`.
- **Every copy is verified.** After copying, all files are re-read and checked by SHA-256.
- **Everything in one folder.** The only argument is the destination folder: it holds the task file
  `af-backup-task.json` and the backups. Each run adds the copied data `backup-data-<start time>` (only your data,
  no service files) and the log of the backup `backup-<start time>.log` - the start, the end, the status
  (success or with errors), errors and warnings; the same lines go to the console.
- **Nothing existing is ever deleted or overwritten.** Each run creates a new backup next to the previous ones;
  delete old backups yourself when they are no longer needed.
- **No error is lost silently:** any error makes the backup finish with errors
  and is reflected in the log, the console and the exit code.
- **Manual runs.** The tool is meant to be started by hand, not by a scheduler (see "Manual runs").

## Installation

Requires [Node.js](https://nodejs.org/) 22 or newer. af-backup is installed from the repository:

```
git clone <repository URL> af-backup
cd af-backup
npm install
npm run build
npm install -g .
```

After that the `af-backup` command is available. af-backup has no runtime dependencies.

`npm install -g .` links the command to the repository folder: do not move or delete the folder.
After updating the repository (`git pull`), run `npm run build` again.

## Quick start

1. Create the destination folder, for example `E:\backups\work`, and copy the task template `af-backup-task.json`
   into it from the [templates](templates) folder of the repository - `templates/windows/af-backup-task.json`,
   `templates/linux/af-backup-task.json` or `templates/macos/af-backup-task.json`.

2. Edit the task - replace the example source paths:

   ```json
   {
     "jsonType": "af-backup-task",
     "version": 1,
     "exclude": ["node_modules", "Thumbs.db", "*.tmp"],
     "sources": [
       { "path": "C:\\work\\docs", "name": "work-docs", "exclude": ["drafts"] },
       { "path": "C:\\Users\\me\\.gitconfig" },
       { "path": "C:\\work\\notes", "compress": true }
     ]
   }
   ```

3. Run:

   ```
   af-backup E:\backups\work
   ```

   or, from inside the destination folder, just `af-backup`.

The result is the folder `E:\backups\work\backup-data-2026-10-04-11-20-15` with a subfolder per source
(for a compressed source - the archive `<name>.tar.gz`, here `notes.tar.gz`) and nothing else,
and the log `E:\backups\work\backup-2026-10-04-11-20-15.log` next to it: the names end with the start time
of the run (`yyyy-mm-dd-HH-MM-SS`, local time). Whether the backup succeeded is shown in the console and recorded in the log (see "Log").

The next run creates a new backup next to this one. Delete old backups (the folder together with its log)
when they are no longer needed or when space runs short: af-backup never deletes them.

## Running

```
af-backup [<destination folder>]
```

This is the only way to run af-backup: there are no other commands or options.
Without an argument the destination folder is the current folder.
The destination folder must exist and contain the task file `af-backup-task.json`;
it must not already hold a backup with the same start time (two runs within the same second).
af-backup keeps nothing in your home folder.

## Task fields

| Field | Required | What it sets |
|---|---|---|
| `jsonType` | yes | always `"af-backup-task"`: marks the file as a task |
| `version` | yes | task format version: `1` |
| `description` | no | free text for notes |
| `exclude` | no | exclusion masks for all sources |
| `sources[].path` | yes | folder or file (absolute path); a folder is copied with all its subfolders at any depth, including empty ones |
| `sources[].name` | no* | subfolder name in the backup, for a compressed source - the archive name `<name>.tar.gz` (default - the last part of the path) |
| `sources[].exclude` | no | exclusion masks for this source |
| `sources[].compress` | no | compress the source into `.tar.gz`, default `false` |

\* Required for the root of a drive or a network share (`D:\`, `/`, `\\server\share`): such a path has no last part.

Masks: `*` - any characters within a name, `**` - any number of folder levels.
A mask without `/` is a name at any depth (`node_modules`), with `/` - a path from the source root (`projects/*/build`).
A folder matching a mask is excluded entirely, so no trailing `/` in masks (`build`, not `build/`).
The summary in the log shows how many items matched each mask.

There is no `destination` field: the destination is the folder the task file lies in.
Unknown fields and wrong types are errors: the task will not run until the file is fixed.

## Log

Every backup has its own log `backup-<start time>.log` in the destination folder (plain text); the same lines are printed
to the console: the start of the backup, warnings and errors, the summary, and the end with the status:

```
2026-10-04 11:20:15.123 INFO  Backup started: destination folder E:\backups\work; ...
2026-10-04 11:20:16.410 INFO  Backup data folder created: E:\backups\work\backup-data-2026-10-04-11-20-15
2026-10-04 11:20:18.517 ERROR work-docs/mail.pst: the file is locked (EBUSY), 3 attempts
2026-10-04 11:25:40.880 INFO  Summary: copied 1520 files / 87 folders / 700 MB; ...
2026-10-04 11:25:40.881 ERROR Backup finished WITH ERRORS: E:\backups\work\backup-data-2026-10-04-11-20-15 is not a valid backup (errors 1), code 1
```

**The log is the only place where the status is recorded:** the backup data folder is created right at the start
and never renamed, so data left by an unsuccessful or interrupted run looks like any other.
A backup is valid only if its log (with the same start time in its name) ends with `Backup finished successfully`.
A log without an end means the run crashed.

If the backup could not start (an error in the task, the disk is not connected, not enough space, etc.),
nothing is created in the destination folder: the reason is printed to the console only. Fix it and run again.
A rare exception: if the disk fails right when the log is being created, the file stays (the console says so).

## Manual runs

af-backup is meant to be **run manually**, not on a schedule: the user connects the disk and starts the backup,
watching the result, and deletes old backups when they are no longer needed. There are no examples
of scheduled runs, and scheduling is not a supported scenario.

Ctrl+C stops the backup gracefully; a second Ctrl+C exits immediately. The result is in the exit code:

| Code | Meaning |
|---|---|
| 0 | the backup finished successfully |
| 1 | the backup finished with errors (including verification mismatches) - it is not a valid backup |
| 2 | could not start (an option or extra arguments, error in the task, disk not connected, etc.) |
| 3 | interrupted |

Verification is always part of the backup; there is no separate command to re-check a backup later.

## Good to know

- A folder source is copied recursively: the backup repeats its whole tree of subfolders, including empty folders.
  Items matching exclusion masks are left out (a matching folder - with all its content).
- Links (symlink, junction) inside a source are not followed - they are skipped with a warning.
  A source that is itself a link is followed.
- File permissions, attributes and owner are not preserved - only content and modification time.
- A file that cannot be read (for example, the database of an always-open program) makes the backup unsuccessful:
  close the program before the backup or add the file to exclusions.
- An empty source is an error (this catches a disconnected source disk).
- A whole disk as a source (`D:\`, `/mnt/data`): its root holds service folders that cannot be read, add them
  to the source's `exclude` - on Windows `"System Volume Information", "$RECYCLE.BIN"`, on Linux `"lost+found"`,
  on macOS `".Spotlight-V100", ".Trashes", ".fseventsd"`. The root of the system drive (`C:\`, `/`) is not supported:
  back up specific folders instead.
- Keep several backups (do not delete the previous one right away): a backup made after an accidental
  deletion or ransomware succeeds too - only older copies and a disk that is not permanently connected protect against that.
- A disconnected destination disk is caught: there is no destination folder, or (on Linux and macOS,
  where a mount point like `/mnt/usb` exists without the disk) there is no task file in it.
- If verification found mismatches right after copying, the destination disk is most likely faulty.
- Compression saves space at the cost of reliability and is pointless for photos, videos, archives.
  On macOS and Linux a compressed source is extracted with `tar -xzf <name>.tar.gz -C <folder>`.
  On Windows, install [7-Zip](https://www.7-zip.org/) (free, open source) in advance rather than at restore time,
  and extract with it: the built-in Windows `tar` (checked on Windows 11) skips files and folders
  with emoji in the path, along with the content of such folders, and extracts the rest correctly.
  af-backup itself does not need 7-Zip. Archive corruption prevents standard tools from extracting files after
  the point of corruption, and to get one file the archive is read from the beginning.

Details are in the [specification](docs/spec.md).

## License and disclaimer

- This code is distributed under the MIT License (see [LICENSE](LICENSE)), unless explicitly stated otherwise.
- This code is provided as is, without any warranty.
- This code was generated by AI under the guidance of the developer.
- The developer gives no guarantees.
