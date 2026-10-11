# AF Backup — specification

A tool for simple personal backups, written in TypeScript for Node.js.

This is the complete behavior specification. A short user-facing description is in the [readme](../readme.md).

## Principles

- **Simplicity.** Limited functionality, no unnecessary features.
- **Reliability.** The top priority. Any ambiguous decision is made in favor of data safety.
- **A backup is a plain folder of files.** Restoring does not need the tool itself: copying the files back is enough.
  Compressed sources are standard `.tar.gz`, which is extracted by built-in OS tools
  and free open-source programs.
- **The task lives with the backups.** The only argument is the destination folder; the task file and the backups
  (the copied data and the log of each) are all inside it (see "Destination folder").
- **Manual runs.** The tool is meant to be started by hand, not by a scheduler: the user connects the disk,
  starts a run and watches the result; old backups are deleted by the user when they are no longer needed
  (see "Destination folder").
  Running on a schedule is not a supported scenario, and the documentation gives no examples of it.

## Platforms

Cross-platform: Windows, Linux, macOS.

## Out of scope

- incremental and differential copies, deduplication;
- encryption;
- compression formats other than `.tar.gz` (see "Compression");
- cloud storage and network protocols (S3, FTP, etc.);
  a network folder mounted as a path works like a regular one;
- scheduled runs (see "Principles" - manual runs);
- a restore command - files are simply copied back;
- preserving permissions, attributes, owner, ACLs, alternate data streams;
- file system snapshots (VSS);
- include filters ("only take `*.jpg`");
- several tasks in one run;
- GUI, background mode, change watching;
- notifications (email, etc.) - the result is shown in the console and in the exit code.

## Running

Console tool `af-backup`. The only way to run it:

```
af-backup [<destination folder>]
```

- at most one argument - the destination folder (copying and verification, see "Task execution");
  a relative path is resolved from the current folder;
- without an argument the destination folder is the current folder (`cd E:\backups\work` and `af-backup`);
- with more than one argument, with an empty argument or with an argument starting with `-` - error, code 2
  (there are no options: no `--help`, `--version`, dry run or interactive mode; the tool asks no questions);
- the destination folder must exist and contain the task file `af-backup-task.json`
  (see "Destination folder"); a task file is created by copying a template from the repository (see "Task template").

**One task per run.** Several tasks - several commands. This way the exit code is always unambiguous.

Verification is always part of a run (see "Verification"); there is no separate command for it.
Exclusion masks are checked by the log of a run (the number of matches of each mask, see "Exclusions").

The tool keeps nothing in the user's home folder or next to the program: no tasks folder, no shared log.

### Log

All service information about a backup is kept **only in its log** **`<destination folder>/backup-<start time>.log`**,
next to the copied data (see "Destination folder"). Each backup has its own log; it is a plain text file:

```
2026-10-04 11:20:15.123 INFO  Backup started: destination folder E:\backups\work; machine DESKTOP-ANDREW, af-backup 1.0.0, Node 22.x, Windows 10.0.26300, time zone +03:00
2026-10-04 11:20:16.002 WARN  Skipped link: work-docs/link -> D:\other
2026-10-04 11:20:16.410 INFO  Backup data folder created: E:\backups\work\backup-data-2026-10-04-11-20-15
2026-10-04 11:20:18.517 ERROR work-docs/mail.pst: the file is locked (EBUSY), 3 attempts
2026-10-04 11:25:40.880 INFO  Summary: copied 1520 files / 87 folders / 700 MB; excluded 312 (node_modules: 5, Thumbs.db: 12, *.tmp: 290, work-docs/drafts: 5); warnings 1; errors 1; verification: OK; duration 5 min 25 s
2026-10-04 11:25:40.881 ERROR Backup finished WITH ERRORS: E:\backups\work\backup-data-2026-10-04-11-20-15 is not a valid backup (errors 1), code 1
```

What is written:

- the start of the run - the destination folder, machine, program, Node.js, OS and time zone; it is the first line,
  produced right after the arguments have been checked, before any other check (with invalid arguments there is
  no such line, only the "could not start" line). The OS is shown by its name and the version Node.js reports:
  on Windows this is the kernel version, Windows 11 shows as 10.0.22000 and above;
- the creation of the backup data folder;
- warnings and errors as they happen (see "Error handling");
- the summary - what was copied, how many items each exclusion mask matched, warnings, errors, verification, duration;
- the end of the run with its status (see "Statuses") and the exit code - the last line.

**When the log file is created.** The log file is created ("new only") at step 5 of "Task execution", after all
the checks and right before the backup data folder: a run that failed a check (steps 1-4) leaves nothing in the destination folder,
so after fixing the problem (for example, the task file) the user simply runs it again.
The lines produced before that (the start line, warnings found while building the file list) are printed to the console
at once and kept in memory; when the log file is created, they are written to it first, with their original times.
If the run could not start (level 1 error, invalid arguments, interrupted before step 5), its lines - including
the final "could not start" line with all the errors - go to the console only.

Format:

- one line per event: local time with milliseconds, the level (`INFO`, `WARN`, `ERROR`), the text;
- UTF-8; paths of copied items are relative to the backup data folder, with `/` (`work-docs/mail.pst`); other paths
  (the destination folder, the backup data folder, the task file, the log, sources) are absolute;
  OS error codes (`EBUSY`, `ENOSPC`) are written next to the text - handy for searching;
- control characters in names (on Linux a file name may contain a newline) are escaped
  (`\n`, `\t`, `\xNN`), so that an event always takes one line;
- excluded items are not listed one by one - the summary shows how many items each mask matched
  (a typo like `node_module` is visible by zero matches);
- written incrementally (appending): what has been written stays on a crash;
  flushed to disk (fsync) after the last line of the run.

**The log is the only place where the status of a backup is recorded**, so a backup does not start
without a log: the backup data folder is created only after the log file has been created and the lines kept so far
have been written to it. If the log file cannot be created or written at step 5 - level 1 error, code 2
(to the console only). A log file that has been created but could not be written stays: the tool does not delete it.
It has no final line - it is not a valid backup; the console message says so. A log write error after that is a level 2 error
(see "Error handling").

### Console output

Everything written to the log is also printed to the console at the same time, in the same format:
`ERROR` and `WARN` lines go to stderr, `INFO` lines to stdout.

In a terminal, a progress line is also shown (files, bytes); it is not written to the log.
If output is not a terminal (for example, redirected to a file) - no progress animation, plain text only.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | the backup finished successfully (warnings are possible) |
| 1 | the backup finished with errors - it is not a valid backup |
| 2 | could not start (level 1 error, invalid arguments) |
| 3 | execution interrupted (Ctrl+C, termination signal) |

## Task

A task is a json file describing a copy job: what to copy. Where to copy is not part of the task:
the task file `af-backup-task.json` lies in the destination folder itself (see "Destination folder").
The file's content conforms to the Task interface.

### Fields

| Field | Type | Required | Default | Rules |
|---|---|---|---|---|
| `jsonType` | string | yes | - | only `"af-backup-task"` (identifies the file as a task) |
| `version` | number | yes | - | only `1` (format version) |
| `description` | string | no | - | free text for notes |
| `exclude` | array of strings | no | `[]` | masks (see "Exclusions") |
| `sources` | array of objects | yes | - | at least 1 element |
| `sources[].path` | string | yes | - | absolute path |
| `sources[].name` | string | no* | last part of the path | source name rules |
| `sources[].exclude` | array of strings | no | `[]` | masks |
| `sources[].compress` | boolean | no | `false` | compress the source into `.tar.gz` (see "Compression") |

\* required if the source is the root of a drive or a network share (`D:\`, `\\server\share`, `/`): such a path has no "last part".

There is no field for the destination: a task file that still has `destination` is an error (unknown field).

Example (this is what the Windows template looks like, see "Task template"; all further examples in this document
are for this task, lying at `E:\backups\work\af-backup-task.json`):

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

### Task template

The tool does not create task files. The repository has a folder `templates/` with static templates,
one subfolder per OS; each template is already named `af-backup-task.json`:

- `templates/windows/af-backup-task.json` - Windows paths (the example above);
- `templates/linux/af-backup-task.json` - the same task with Linux paths (`/home/me/...`), without the Windows junk
  mask `Thumbs.db`;
- `templates/macos/af-backup-task.json` - the same task with macOS paths (`/Users/me/...`), with `.DS_Store`
  instead of `Thumbs.db`.

The templates do not exclude `.git`: in a folder with projects it holds commits, branches and stashes that may exist
nowhere else.

The user creates the destination folder, copies the template into it
(for example, `E:\backups\work\af-backup-task.json`) and replaces the example source paths.
The templates are valid tasks: they pass validation as they are.

### Validation

Validation is strict; any error is a level 1 error, the task does not run.

- **Unknown field - error.** Otherwise the typo `"exlude": [...]` would silently become the default
  value - an empty exclusion list, and `"compres": true` - an uncompressed source.
- **No type coercion:** `"compress": "true"` and `"exclude": "*.tmp"` are errors.
- **Duplicate key in JSON** (two `"exclude"`) - error
  (the standard `JSON.parse` silently takes the last one - a parser that catches duplicates is needed).
- **Absolute paths only** (a relative one would depend on the current folder). `~` and environment variables are not expanded.
- On Windows an absolute path is a drive letter with a separator (`C:\work`) or a network path (`\\server\share\...`).
  The paths `\work` and `/work` (from the root of the current drive) and `C:work` (from the current folder of drive C:) are errors,
  even though `path.isAbsolute` treats the first two as absolute. The `\\?\` and `\\.\` prefixes are not accepted
  (long paths are supported without them).
- On Windows both separators are accepted in paths: `C:\\work` and `C:/work`.
- **`jsonType`** other than `"af-backup-task"` or missing - error "this is not an af-backup task file".
- **`version`** greater than `1` (an integer) - error "task format is newer than the program - update af-backup";
  missing, or any other value (`"1"`, `1.5`, `0`) - an error in the `version` field.
  In all these cases the other fields are not checked: their meaning depends on the format.
- Encoding UTF-8, a BOM is allowed (Windows Notepad adds it).
- Plain JSON, no comments; use the `description` field for notes.
- **All errors are reported at once** and with the path to the field, for example: `sources[1].name: invalid character ":"`.

### Changing an existing task

- **Another destination** - the task file is copied into another destination folder; the next backup is made there,
  the old backup stays where it is.
- **`compress` changed** - the next backup gets the new source layout (folder or archive),
  existing backups do not change.
- **Moving to a new machine** - the destination folder (with the task file) is used as is.

### Sources

A source is a specific folder or file. Masks are not allowed in a source path;
masks are used only in exclusions inside a source (see "Exclusions").
If several folders are needed (for example, `C:\projects\*\src`), these are several sources.

Each source has a name - the name of its subfolder inside the backup (for a compressed source - the archive name `<name>.tar.gz`):

```json
"sources": [
  { "path": "C:\\work\\docs", "name": "work-docs" },
  { "path": "C:\\Users\\me\\.gitconfig" }
]
```

If the name is not set, the last part of the path is used (`C:\Users\me\.gitconfig` → `.gitconfig`).
For a drive root the name is required.

When a task is loaded, names (including those taken from the path by default) are checked:

- unique case-insensitively (the backup may be on a disk where `Docs` and `docs` are the same folder);
- contain only characters valid on all OSes; no `/`, `\`;
- are not `.` or `..` and do not end with a dot or a space (Windows silently drops them);
- are not reserved Windows names (`CON`, `NUL`, `COM1`, etc.),
  including with an extension (`CON.txt`, `nul.tar.gz`);
- for a compressed source the archive name `<name>.tar.gz` is checked too: it must not match
  (case-insensitively) the name of another source.

If the check fails, the task does not run and a clear error is printed.

If a source does not exist or is unavailable (folder deleted, network drive disconnected) - this is a level 3 error,
the backup finishes with errors. A source is never skipped silently.

**An empty source folder** (it has no items at all, even before exclusions are applied) is also a level 3 error
"source is empty - the disk may not be connected". On Linux and macOS a mount point (`/mnt/data`) without
a connected disk is an existing empty folder; without this check a successful backup with no files would result.
If a source really is empty, it is removed from the task.

**A drive root as a source** (`D:\`, `/mnt/data`, a mounted external disk). The root of a file system holds
service folders that a regular user cannot read; with the strict error policy they would make every backup
of such a source unsuccessful (a level 3 error each time). Nothing is excluded automatically: the user adds
them to the source's `exclude`, so that they are visible in the task and in the mask summary of the log:

| OS | Masks | Why |
|---|---|---|
| Windows | `System Volume Information`, `$RECYCLE.BIN` | `System Volume Information` cannot be read (`EPERM`); in `$RECYCLE.BIN` the recycle bins of other users cannot be read, and the user's own one is junk (checked 2026-10-10, Windows 11) |
| Linux | `lost+found` | readable by root only on ext2/3/4 (to be checked before the release) |
| macOS | `.Spotlight-V100`, `.Trashes`, `.fseventsd` | service folders of external disks, some are not readable (to be checked before the release) |

```json
{ "path": "D:\\", "name": "disk-d", "exclude": ["System Volume Information", "$RECYCLE.BIN"] }
```

`$` in a mask is a literal character; on Windows and macOS masks are case-insensitive (`$RECYCLE.BIN` matches `$Recycle.Bin`).
Backing up the root of the system drive (`C:\`, `/`) is not a supported scenario: it holds files that cannot be read
at all (`pagefile.sys`, `hiberfil.sys`, the `Recovery` folder; `/proc`, `/sys`) and files locked by the running OS -
back up specific folders instead.

### Exclusions

A source is copied in full, except for exclusions. There are no include filters ("only take `*.jpg`").

Exclusions are set on two levels:

- the task's `exclude` - applies to all sources (handy for junk: `node_modules`, `Thumbs.db`, `.DS_Store`, `*.tmp`);
- the source's `exclude` - only for this source.

```json
{
  "exclude": ["node_modules", "Thumbs.db", "*.tmp"],
  "sources": [
    { "path": "C:\\work\\docs", "name": "work-docs", "exclude": ["drafts", "projects/*/build"] }
  ]
}
```

**Mask syntax:**

| Element | Meaning |
|---|---|
| `*` | any characters within one name (does not cross `/`), including none; also matches names starting with a dot |
| `**` | any number of folder levels, including none; only as a whole path segment between `/` (`**/logs`, `a/**/b`) |
| everything else | literal, including `?`, `[`, `]`, `{`, `}`, `!` |

`?`, `[...]`, `{a,b}` and negation `!` are not supported: these characters occur in real file
names and give unexpected matches.

**Anchoring:**

- a mask **without `/`** is matched against the **name** of a file or folder at any depth
  (`node_modules`, `*.tmp`, `Thumbs.db`);
- a mask **with `/`** is matched **from the source root** (`projects/*/build`, `cache/tmp`, `**/logs/*.log`).

**Rules:**

- the separator in masks is always `/`, including on Windows;
- if a folder matches a mask, it is excluded entirely and the tool does not go inside;
- an exclusion cannot be undone (there is no negation);
- case sensitivity follows the OS: case-insensitive on Windows and macOS, case-sensitive on Linux;
- the source root never matches a mask - masks work only inside it;
- exclusions are not applied to a file source (it is given explicitly).

**Order:** exclusions are checked first. An excluded item is not read at all, so:

- a locked but excluded file is not an error (this is how "always locked" files are handled);
- an excluded link, socket or FIFO - no warning.

**Validation.** Level 1 error (the task does not run) if a mask:

- is empty, contains `\` or a path segment `.` / `..`;
- is an absolute path (`C:/...`, `/home/...`, including `.gitignore`-style `/build`);
- ends with `/` (`build/`): a folder is excluded entirely anyway, and such a mask means
  different things in different tools;
- contains `**` not as a whole path segment (`a**b`);
- ends with `**` (`a/**`): a folder is excluded entirely anyway - write `a`;
- consists only of `*` and `**` segments (`*`, `**/*`, `*/*`) - it names nothing specific
  and would exclude the whole content of the source or entire levels.

**Transparency.** The summary in the log shows how many items matched each mask (an excluded folder counts
as one item, its content is not counted): a typo like `node_module` is visible by zero matches. An item matching
several masks is counted by each of them, so a zero always means that the mask matched nothing; the total
`excluded N` counts items, not matches.
Excluded items are not listed one by one. This is information, not a warning.

### Compression

A source can be compressed: `"compress": true`. Then instead of a `<name>/` subfolder the backup data folder
gets a single archive `<name>.tar.gz`. For example, in the example task the source `C:\work\notes` is compressed:

```
backup-data-2026-10-04-11-20-15/
  work-docs/...              - uncompressed source
  .gitconfig/.gitconfig      - uncompressed source
  notes.tar.gz               - compressed source C:\work\notes
```

**Format - `.tar.gz`**: a tar archive in POSIX pax format, compressed with gzip. Format requirements:

1. it is relatively simple to write and to check that it was written correctly;
2. it can be extracted without af-backup - with built-in OS tools or free programs,
   preferably open source.

What extracts it:

| OS | Tool |
|---|---|
| Windows 10 (1803+), Windows 11 | 7-Zip - recommended; built-in `tar -xzf notes.tar.gz` (bsdtar / libarchive) - does not extract entries with emoji in the path |
| Windows 11 | File Explorer - `.tar.gz` support exists in recent builds (to be checked, see below) |
| macOS | Finder (Archive Utility), `tar` |
| Linux | `tar` |
| any | 7-Zip (open source, LGPL) |

The command `tar -xzf <archive> -C <folder>` is the same on all three OSes (on Windows - with the emoji caveat, see below).

**The built-in Windows `tar` does not support emoji in paths.** bsdtar converts paths to the ANSI
code page (for example, 1251), which has no emoji: it skips such entries with the error
`Archive entry has empty or unreadable filename` and exits with code 1. The emoji can be in any part
of the path: if it is in a folder name, the folder itself and all its content are skipped, even items with plain names.
The remaining entries are extracted correctly. This is a limitation of bsdtar itself, not of the format: it cannot even
create an archive with emoji (checked 2026-10-03, bsdtar 3.8.8, Windows 11, code page 1251;
not checked on Windows 10, but the cause is the same). Therefore 7-Zip is recommended for extracting on Windows.

**7-Zip is needed only for manual restore.** af-backup does not call 7-Zip or any other external
programs: it writes and verifies the archive itself, otherwise there would be no per-file rollback and retries (see "Errors
and retries") and no SHA-256 computed during the same read. 7-Zip is not needed for af-backup to work. Windows
users who enable compression are advised to install 7-Zip in advance rather than at restore time:
by then there may be no internet or the system may be freshly installed. The built-in `tar` is fine if there are no emoji in paths.

**Why not ZIP.** ZIP opens in File Explorer on all Windows versions and is more resilient to corruption,
but writing it correctly is noticeably harder. A compatibility check (2026-10-03, Windows 11:
File Explorer and `tar`/bsdtar 3.8.8) showed that bsdtar cannot read an archive in which an entry larger than 4 GB is written
with a data descriptor and without a ZIP64 field in the local header - it fails after that entry. This is how
.NET `ZipArchive` and popular Node.js libraries (`archiver` 8.0.0, `yazl` 3.3.1) write - writing
without descriptors would require an own ZIP64 implementation. Writing tar is a simple sequential format,
and gzip is built into Node.js (`zlib`).

**Archive layout:**

- tar in POSIX pax format (POSIX.1-2001): for each entry - a pax extended header with the full path
  (`path`, UTF-8) and the modification time with fractional seconds (`mtime`), for files of 8 GiB and above - also
  the size (`size`); followed by a regular ustar header (its name is truncated, the full one is in pax);
- entry types - only file and folder; folder entries - for all folders, including non-empty ones
  (so the set of folders is checked by verification); a folder comes before its content;
- permissions and owner are not preserved (see "Out of scope"): permissions are `0644` for files
  and `0755` for folders, owner is `0`, owner names are empty;
- the archive ends with the standard tar end - two zero blocks;
- **each entry is a separate gzip member** (the gzip format allows several members in a row, they are
  extracted as one stream): this way an unfinished entry can be rolled back (see "Errors and retries").
  The tar end is a separate member too.

One archive per source rather than compressing each file separately (`report.docx.gz`):
otherwise restoring would require decompressing each file, and small files would save no space
(each takes at least one file system block).

Paths inside the archive are relative to the source root (without the source name). A compressed file source is an archive
`<name>.tar.gz` with a single entry - that file.

**Compatibility check** - **partially done**, the full one is required before the release (it is repeated then
on an archive written by af-backup itself; decided 2026-10-04: compression is implemented before the check is completed). A test archive
written by the rules above: a file larger than 8 GiB (incompressible data), more than 70,000 entries,
Cyrillic names, a name with emoji, a path longer than 260 characters, an empty folder. The extracted result is compared
with the source files by SHA-256. Tools: `tar` on Windows 10 and 11, File Explorer on Windows 11, 7-Zip,
Finder and `tar` on macOS, GNU `tar` on Linux. The check script is `scripts/tar-gz-compatibility.ts`: it creates test data,
packs it by the rules above (with a simulated rollback), extracts it with the tools it finds and compares;
File Explorer and Finder - manually, compared by the same script.

Results (2026-10-03, Windows 11, archive 8.02 GiB, 70,118 files and 123 folders, with one entry rolled back):

| Tool | Result |
|---|---|
| 7-Zip 24.07 | everything matched, modification time exact |
| GNU `tar` 1.35 (from Git for Windows) | everything matched, modification time exact |
| Python 3.13 `tarfile` | everything matched, modification time - within 1 µs |
| `tar` on Windows 11 (bsdtar 3.8.8) | 3 entries with emoji in the path not extracted (see above), the rest matched |

Not checked: File Explorer on Windows 11, `tar` on Windows 10, Finder and `tar` on macOS, GNU `tar` on Linux.

**Errors and retries.** Before each file is written, the current archive size is remembered - the boundary
between gzip members. If writing a file failed, the archive is truncated to that boundary (**rollback**):
only complete entries remain in the archive. So files of a compressed source are handled the same way
as files of an uncompressed one:

- an open or read error, the file changed while being read - rollback and retries as usual
  (see "Retries" and "Files changing during copy"); after the last failure -
  a level 3 error, the file is not in the archive, archiving continues with the next file;
- the source became unavailable - rollback, archiving of the source stops (see "Source became unavailable"),
  the archive is finished with the tar end;
- the archive exceeded the destination file system limit (`EFBIG`, for example 4 GB on FAT32) - rollback,
  archiving of the source stops, level 3 error, the archive is finished with the tar end if possible;
  if the tar end does not fit either, the archive stays incomplete: its files are not counted as copied
  and verification does not check it (the level 3 error has already been reported, and an incomplete archive
  is not a sign of a faulty disk);
- an archive write or truncation error - level 2 (destination).

**Interaction with the other rules:**

| Rule | For a compressed source |
|---|---|
| exclusions, links, special files | unchanged |
| read errors, file changing while being read, retries | as for an uncompressed source, an unfinished entry is rolled back (see above) |
| long paths, invalid names, case collisions | do not occur inside the archive (tar allows any names); the problem moves to extraction time |
| folders (including empty ones) | folder entries in tar |
| flush to disk (fsync) | once for the archive at the end (faster than for each file) |
| free space check | by the **uncompressed** size - an upper estimate, on the safe side |
| interrupted backup | archive without the tar end - incomplete; the backup is not valid anyway (interrupted) |
| verification | see "Verification" |

**Reliability trade-off.** In a plain folder a corrupted byte damages one file.
In `.tar.gz` corruption damages the gzip member with that file, and standard tools stop at the error:
**files after the point of corruption are not extracted by standard tools** (gzip members are independent,
so they can be recovered with special gzip recovery utilities). Besides, the archive has no index:
to get one file, the archive is read from the beginning up to that file. Corruption at the time of the backup
is caught by verification, and the damage is limited by keeping several backups (previous backups are kept
in the destination folder until the user deletes them, see "Destination folder").
Compression saves space at the cost of reliability. It is pointless for already compressed data (photos, videos, archives)
and useful for text, documents, code.

## Destination folder

The destination folder is the only argument of a run, for example `E:\backups\work`. It holds the task
and the backups, one pair of a backup data folder and a log per run:

```
E:\backups\work\
  af-backup-task.json                - the task (created by the user, see "Task template")
  backup-data-2026-10-03-18-30-12\   - the copied data of an earlier backup
  backup-2026-10-03-18-30-12.log     - its log
  backup-data-2026-10-04-11-20-15\   - the copied data (created by the run, see "Backup data folder")
  backup-2026-10-04-11-20-15.log     - the log of the backup (created by the run, see "Running → Log")
```

**Backup names.** Each run creates the backup data folder `backup-data-<start time>` and the log `backup-<start time>.log`,
where `<start time>` is the local time at which the run started, to the second, in the format `yyyy-mm-dd-HH-MM-SS`
(`backup-data-2026-10-04-11-20-15`, `backup-2026-10-04-11-20-15.log`). The start time is fixed once, at the very
beginning of execution (before step 0); it is also used for the duration in the summary. The same start time
in both names tells which log belongs to which backup data folder.

**Requirements** (each failed one is a level 1 error, the backup does not start, nothing is created):

- **the destination folder exists** and is a folder (a link to a folder is followed: the user gave it explicitly);
  the tool never creates it. If it is missing - "the destination folder does not exist - the disk may not be connected";
- **it contains a valid task file `af-backup-task.json`** (see "Task → Validation"). If the file is missing -
  "task file not found - the disk may not be connected";
- **it contains neither `backup-data-<start time>` nor `backup-<start time>.log` with the start time of this run** -
  nothing at all with these names (a folder, a file, a link; names are compared as the file system does).
  Otherwise - "the destination folder already holds a backup with the same start time - run again".
  This happens only when two runs start within the same second, or when the clock has been moved back
  (for example, at the end of daylight saving time).

The destination folder may contain anything else, including backups with other start times: the tool does not look at it.
The destination folder may be the root of a drive (`E:\`).

**Each run creates a new backup next to the previous ones**; the tool never writes into, overwrites or deletes
an existing backup. Previous backups stay in the destination folder until the user deletes them (both the backup data
folder and its log) or moves them elsewhere. This is how several backups are kept; the free space check
(see "Safeguards → Free space") counts only the free space of the disk, so old backups are deleted by the user
when space runs short.

**The backup is written straight into its backup data folder, and the folder is never renamed.**
Its name says nothing about the result: the status of a backup is recorded only in its log
(see "Running → Log" and "Statuses"). A backup left by an unsuccessful, interrupted or crashed run looks like
any other - before using a backup, check its status in its log.

**A disconnected disk** is caught by the requirements above: on Windows the destination folder does not exist
(there is no `E:`), on Linux / macOS a mount point (`/mnt/usb`) without a connected disk is an existing empty folder,
but it has no task file.

## Backup data folder

The backup data folder `backup-data-<start time>` contains **only the copied data** - no service files (no manifest,
run file or log inside):

```
backup-data-2026-10-04-11-20-15/
  work-docs/...              - content of source C:\work\docs
  .gitconfig/.gitconfig      - file source C:\Users\me\.gitconfig
  notes.tar.gz               - compressed source C:\work\notes
```

- **each source is in its own subfolder**, even if there is only one source;
  adding a new source does not change the structure of the others;
- **a file source** is also put into a subfolder with its name - the rule is uniform: one source - one subfolder;
- **a compressed source** - a single archive `<name>.tar.gz` instead of a subfolder (see "Compression").

When the backup was made - is in the name of the folder; with what result - in the log next to it, with the same start time
in its name (see "Running → Log").

## Statuses

The status of a backup is recorded only in its log `backup-<start time>.log`, in the line that ends the run;
the line names the backup by its backup data folder (in the examples - `E:\backups\work\backup-data-2026-10-04-11-20-15`):

| Status | Log line | Meaning |
|---|---|---|
| success | `INFO ... Backup finished successfully: E:\backups\work\backup-data-2026-10-04-11-20-15, code 0` | everything is copied and verified, there were no errors - **the only valid backup** |
| with errors | `ERROR ... Backup finished WITH ERRORS: E:\backups\work\backup-data-2026-10-04-11-20-15 is not a valid backup (errors N), code 1` | there were copy or verification errors, or a fatal error stopped the run |
| interrupted | `ERROR ... Backup INTERRUPTED: E:\backups\work\backup-data-2026-10-04-11-20-15 is not a valid backup, code 3` | Ctrl+C or a termination signal |
| could not start | `ERROR ... Backup could not start, code 2: ...` | a level 1 error; in the log file - only if the backup data folder could not be created after the log (see step 5); the backup data folder was not created |

- A backup is valid only if its log ends with the "finished successfully" line; warnings are allowed.
- A log without a final line means that the run crashed (the process was killed, power was lost);
  the backup is not valid.
- A run that could not start before step 5 creates no log: its lines, including "Backup could not start", are
  printed to the console only (see "Running → Log").

## Task execution

0. The "Backup started" line is printed to the console and kept in memory: it becomes the first line of the log
   (see "Running → Log").
1. Destination folder check: it exists, there is nothing named `backup-data-<start time>` or `backup-<start time>.log`
   with the start time of this run in it (see "Destination folder").
2. Reading and validation of the task file `af-backup-task.json` (fields, source names, exclusion masks).
3. Path overlap check.
4. Building the file list, "same disk" check, free space check.
   Exactly this list is copied: files that appear later do not get into this backup,
   files that disappear are a level 3 error. The list is kept in memory (on the order of hundreds of bytes per file -
   hundreds of megabytes per million files; acceptable for a personal backup).
5. The destination folder check is repeated (building the list may take a long time), then the log file
   `backup-<start time>.log` is created (in "new only" mode) and the lines kept in memory are written to it, then the backup
   data folder `backup-data-<start time>` is created (in "new only" mode) and the "Backup data folder created" line
   is written to the log.
6. Files are copied. While copying, SHA-256 is computed for each file and kept in memory together with its
   relative path and size - the list of copied items, needed only for verification.
   Each copied file is flushed to disk (fsync); for a compressed source - the archive, once at the end;
   on Linux and macOS - also each created folder and the destination folder (see "Writing to disk").
7. Verification (see "Verification").
8. The summary and the final line with the status are written to the log, the log is flushed to disk.

A level 1 error is possible only at steps 1-4 and when creating the log file or the backup data folder at step 5.
Before the log file is created nothing is created in the destination folder. A created log file always stays,
even if the run could not start: if the lines kept in memory cannot be written to it, it has no final line;
if the backup data folder cannot be created after the log file, the log ends with the "could not start" line.

Level 3 errors and warnings found while building the list (source missing or empty, folder unreadable,
name not in UTF-8, skipped links) do not stop the run: they are written to the log and the console as they are found,
and the corresponding items are not copied.

## Safeguards

All checks are done **before anything is created in the destination folder**. A failed check is a level 1 error,
except for cases explicitly named warnings.

### Existing backup

See "Destination folder": the destination folder must exist and must not hold `backup-data-<start time>`
or `backup-<start time>.log` with the start time of this run. Principle: **the tool never deletes or overwrites anything that existed before the run** - only its own
unfinished files inside the backup data folder it has just created (see "Retries").

### Overlapping paths

These are errors:

- the destination folder is inside a source or equals it (the backup would be written into the data being backed up);
- a source is inside the destination folder (the data being backed up would include the backup being written);
- one source is inside another or equals it (duplicates, almost certainly a mistake in the task).

Nothing is excluded automatically. Paths are compared **after resolving links**
and **always case-insensitively** (on Linux this may give a false positive - on the safe side).
If a source does not exist, the path is compared as given (the source itself will give a level 3 error).

### Concurrent runs

Two runs with the same destination folder at the same time: runs started in different seconds write different
backups and do not interfere. Runs started within the same second have the same names: the log file is created
atomically, in "new only" mode, before the backup data folder, so only one of the runs creates it; the other stops
with a level 1 error (to the console only). No lock file is needed.

### Free space

Before copying, the required space is estimated (in the destination folder):

- each file's size is rounded up to the block size of the destination file system
  (with many small files the difference is significant);
- for a compressed source the uncompressed size is used - an upper estimate;
- margin - 1% of the total, but at least 100 MB (folders, estimation error).

If there is not enough space - level 1 error. If space runs out during copying, this is a level 2 error.

### Same disk

If a source and the destination are on the same device - warning:
such a backup does not protect against disk failure.

Known limitation: volumes are compared (`dev` from `stat` of the destination folder),
so two partitions of the same physical disk are considered different devices - there will be no warning.

## What is copied

What is copied is **file content and folder structure** - not everything a file system can do.

| Case | Behavior |
|---|---|
| regular files, including hidden and system ones (dotfiles, `desktop.ini`, `Thumbs.db`), `.lnk` shortcuts | copied |
| folders, including empty ones | created |
| symlink / junction inside a source | skipped, warning (the log records the link path and its target) |
| the source itself is a link | the link is followed (the user gave it explicitly) |
| socket / FIFO / device file | skipped, warning; the type is determined **before opening** (reading a FIFO may hang forever) |
| hard links | copied as separate files (content is duplicated) |
| sparse files | copied expanded (may take more space) |
| cloud placeholder files (OneDrive, Dropbox "on demand") | downloaded when read; if the download fails - error |
| file modification time | preserved; if it cannot be set - warning |
| creation time | not preserved |
| Unix permissions, Windows attributes (including "read-only"), ACLs, owner, NTFS alternate data streams, extended attributes | not preserved |

Links are not followed because that leads to cycles (for example, junction loops in a Windows profile),
duplicates and going outside the source. If the content a link points to is needed,
it is added as a separate source.

Attributes are not preserved for simplicity and portability; besides, "read-only" in a backup
would get in the way of deleting it.

### Long paths and file names

A path in a backup is longer than in the source (the backup data folder path and the source name are added).

- Long paths on Windows (more than 260 characters) are supported.
- File names are **not renamed or escaped** - the backup stays an exact copy.
- If a file or folder cannot be created (the path is too long, the name is invalid on the destination disk,
  for example `:` or `?` when backing up from Linux to NTFS) - level 3 error.
- A file larger than the destination file system limit (`EFBIG`; for example, 4 GB on FAT32) - a level 3 error
  for that file, not level 2: the rest keeps being copied. For a compressed source this means
  the archive exceeded the limit: the entry is rolled back, archiving of the source stops (see "Compression").
- A name in the source that cannot be represented in Unicode (on Linux - non-UTF-8 bytes; Node.js mangles such
  names and cannot open the file) - level 3 error "file name is not in UTF-8 encoding" with the escaped name,
  no retries. For a folder with such a name, all its content is skipped (one error). Exclusions are checked first
  here too: masks are matched against the name with the invalid bytes replaced by U+FFFD, and a matching item
  is excluded without an error.
- Each file is created **in "new only" mode**: if the file already exists, this is a level 3 error.
  The backup data folder is always new, so an existing file means a name collision - for example,
  `Readme` and `readme` from Linux on a case-insensitive disk. This catches overwrites with any combination of OSes.

### Files changing during copy

The file's size and modification time are compared before and after copying.
If they changed, the file is copied again (see "Retries"); if it keeps changing - level 3 error.
For a compressed source - the same, the unfinished entry is rolled back (see "Compression").
Constantly changing files (for example, logs of running programs) should be added to exclusions.

Known limitation: a change within one modification time "tick" is not detected.

## Writing to disk

Without a forced flush, the OS keeps written data in the cache. If power is lost after the "finished successfully"
line has reached the disk but before the data has, the log would call a backup with corrupted files valid -
this would break the main guarantee.

So every copied file (or compressed source archive) is flushed to disk (fsync) **before** the final line
is written to the log, and the log is flushed after it.

On Linux and macOS flushing a file is not enough: the file's entry in the folder (its name) is flushed separately,
and without that, after a power loss the file may disappear from the backup. So there each created folder is flushed
too - after all its items have been created (including the backup data folder itself and then the destination folder,
which holds the entries of the backup data folder and the log). On Windows flushing folders is not available; it is not done there.

A flush error of the backup is a level 2 error. The cost is a noticeable slowdown with many small files
(especially on USB drives); it is justified for the sake of the guarantee.

If power is lost before the final line reaches the disk, the log has no final line -
the safe side: the backup is not considered valid.

## Verification

Verification is always part of a run (step 7 of "Task execution"); there is no separate command for it.

Each copied file is re-read from the destination and its SHA-256 is compared with the hash computed while copying
(kept in memory, see step 6). It is also checked that the set of files and folders in the backup data folder
matches the list of copied items exactly: a missing or an extra item is a mismatch. The rest of the destination folder
(the task file, the log, other backups, anything else) is not checked.

For a compressed source:

1. The SHA-256 of the archive file is compared with the hash computed while writing it.
2. **The archive is extracted completely** (in memory, as a stream, without writing to disk): the gzip
   checksums of each member and the tar header checksums are checked, and the archive must end with the tar end.
3. The SHA-256 of the content of each file entry is compared with the hash of the source file.
4. The set of entries in the archive (files and folders) matches the list of archived items.

This checks the main thing: that the correct files can actually be restored from the archive.

Verification does not stop at the first mismatch: all files are checked, all mismatches are written to the log
as errors. A mismatch is a sign of a problem with the destination disk, so the log says so in a separate line before the summary
(except unfinished files that could not be deleted, see "Retries": they are explained by the warning written while copying).

Known limitations:

- verification right after copying most likely reads data from the OS cache
  (Node.js cannot read bypassing the cache), i.e. checks it in the form the OS returns it;
- the hashes are not kept after the run (there are no service files in the backup), so data corruption
  on the destination disk after the backup has been made is not detected by the tool;
  several backups on different disks limit the damage.

## Error handling

**The main rule:** a backup finishes successfully only if there was not a single error.
Warnings are allowed.

| Level | Examples | Reaction |
|---|---|---|
| **1. The task cannot start** | invalid arguments; the destination folder does not exist (disk not connected); the task file is missing or invalid (fields, names, masks); the destination folder already holds a backup with the same start time; overlapping paths; not enough space; the log file cannot be created or written (including a concurrent run with the same destination folder started within the same second); the backup data folder cannot be created | the backup data folder is not created; error to the console ("Backup could not start"), code 2; to the log only if the log file had already been created (see "Task execution", step 5) |
| **2. Fatal error** (the destination or the log as a whole) | out of space, disk disconnected, no write permission, write error, flush (fsync) error, log write error | immediate stop, the backup finishes with errors |
| **3. Item error** | reading the source: file locked, no read permission, read error, file disappeared during the run, file keeps changing, folder unreadable, name not in UTF-8, source missing entirely, empty or became unavailable during the run; creating in the backup: path too long, name invalid on the destination disk, name collision, file (or compressed source archive) larger than the file system limit; verification mismatches | the item is skipped, the error is written to the log and the console, copying continues; the backup finishes with errors |
| **4. Warning** | skipped link, socket or FIFO; could not set the modification time; source and destination on the same disk; the free space cannot be determined (the check is skipped) | written to the log and the console, does not affect the status |

If the log cannot be written after a fatal error, the final line and the summary go to the console only.

### Retries

Before a file is considered failed (level 3), 2 more attempts are made with a pause of about a second.
This helps with short network glitches and short locks (for example, an antivirus scan).

Before a retry, our own unfinished file in the backup is deleted - otherwise the retry would run into
creating the file in "new only" mode. After the last failed attempt it is deleted too:
the backup contains no files that are not in the list of copied items. If deletion failed - a warning;
the file gets no more attempts (a retry would only run into the leftover file), and verification shows the leftover
as an extra file - named as an unfinished file that could not be deleted, not as a sign of a faulty disk.
For a compressed source, instead of deleting a file, the unfinished entry is rolled back by truncating the archive (see "Compression").

On Windows deletions often fail briefly (`EPERM`, `EACCES`, `EBUSY`): freshly written files are held open
by antivirus, the search indexer, File Explorer. So they are retried with an increasing pause for about 10 seconds,
and only then considered failed.

**Source became unavailable.** If the network or external disk of a source disconnects during copying,
retries for each remaining file would take hours. So after a read error it is checked
whether the source root is available. If not - copying of this source stops without retries:
one level 3 error with the number of files not copied; the other sources keep being copied.
For a compressed source the unfinished entry is rolled back and the archive is finished with the tar end (see "Compression").

### Always-locked file

The policy is strict: any error makes the backup unsuccessful. If some file can never be read
(for example, the database of an always-open program), the user sees it in the log and the exit code and decides:
close the program before the backup or add the file to exclusions.
There is no mechanism of "optional" files - nothing is lost silently.

### Stopping by the user

On Ctrl+C (and a termination signal) the program stops gracefully and exits with code 3:

- if the log file has not been created yet (steps 0-4) - the run ends with "Backup could not start: interrupted, code 3"
  (to the console only), nothing is created;
- otherwise copying or verification stops, and the log gets the summary and the "Backup INTERRUPTED" line;
  the backup stays as it is (not a valid backup).

**A second Ctrl+C** (or termination signal) while the graceful stop is still in progress (for example, it hangs
on reading from a dropped network share) - immediate exit with code 3, without waiting: the log has no final line
for this run - the backup is not considered valid, the safe side.

### Exit codes

See "Running → Exit codes".

## Guarantees

- Nothing is written to a source.
- A backup whose log ends with the "finished successfully" line contains a complete and verified copy -
  everything that must be copied by the task rules (exclusions and links and special files skipped with a warning
  are visible in the log), and its data had been flushed to disk before that line was written.
- The tool never deletes, overwrites or writes into anything that existed before the run: if the destination folder
  already holds `backup-data-<start time>` or `backup-<start time>.log` with the start time of this run, the backup
  does not start. The only things it deletes are its own unfinished files inside the backup data folder it has just created.
- Nothing is written in the destination folder outside the backup data folder and the log of this run;
  the tool does not create the destination folder and does not write task files.
- No error is lost silently: any error makes the backup finish with errors
  and is reflected in the log, the console and the exit code.
