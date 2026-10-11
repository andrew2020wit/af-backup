# How AF Backup works

A visual overview of what happens during `af-backup [<destination folder>]`, mapped onto the source code.
[spec.md](spec.md) is the source of truth for behavior; this file only shows how it fits together.

## Modules

Who calls whom. Everything that touches the file system goes through `fileSystemOperations`
(tests replace its methods to simulate faults).

```mermaid
flowchart TD
  main["main.ts<br/>signals → AbortController, exit code"]
  cli["cli.ts<br/>arguments → run"]
  arguments["utilities/arguments.ts<br/>at most one argument"]
  pipeline["run-pipeline.ts<br/>steps 0-8, summary, final line"]
  prepare["services/prepare.ts<br/>steps 1-4"]
  fileList["services/file-list.ts<br/>file list, exclusions"]
  copier["services/copier.ts<br/>uncompressed source, retries"]
  archive["services/archive-source.ts<br/>compressed source"]
  report["services/run-report.ts<br/>counts errors and warnings"]
  verifier["services/verifier.ts<br/>step 7"]
  tar["services/tar-writer.ts, tar-reader.ts, tar-format.ts"]
  task["services/task-loader.ts, task-validator.ts<br/>af-backup-task.json: strict JSON, names, masks, paths"]
  destination["services/destination.ts<br/>no backup with this start time yet"]
  log["services/log.ts<br/>backup-TIME.log + console"]
  fs["services/file-system-operations.ts<br/>safe-file-system.ts"]

  main --> cli
  cli --> arguments
  cli --> pipeline
  pipeline --> log
  pipeline --> prepare
  prepare --> destination
  prepare --> task
  prepare --> fileList
  pipeline --> copier
  pipeline --> archive
  archive --> copier
  archive --> tar
  pipeline --> verifier
  verifier --> tar
  fileList --> report
  copier --> report
  report --> log
  copier --> fs
  archive --> fs
  verifier --> fs
  fileList --> fs
  log --> fs
```

## A run, step by step

TIME below is the start time of the run, `yyyy-mm-dd-HH-MM-SS` (`backup-data-2026-10-04-11-20-15`).

Nothing is changed on disk before step 5: a failure at steps 1-4 (or creating the log file at step 5) is
"could not start", printed to the console only, and nothing is created in the destination folder (except a log file that
was created but could not be written: it stays). The lines produced
before step 5 are kept in memory and written to the log file first when it is created. From the creation of the backup data folder on,
the run always ends with the summary and a final line.

```mermaid
flowchart TD
  start(["af-backup FOLDER"]) --> args{"at most one<br/>argument?"}
  args -- no --> cannotStart
  args -- yes --> s0["0. 'Backup started'<br/>(console + memory)"]
  s0 --> s1["1. destination folder exists,<br/>no backup with this start time"]
  s1 --> s2["2. read and validate<br/>af-backup-task.json"]
  s2 --> s3["3. overlapping paths"]
  s3 --> s4["4. file list (exclusions first),<br/>same disk (warning), free space"]
  s4 --> s5["5. destination folder check again,<br/>create backup-TIME.log,<br/>then backup-data-TIME<br/>(both 'new only')"]
  s1 & s2 & s3 & s4 & s5 -- "level 1 error" --> cannotStart
  s5 --> s6["6. copy each source<br/>(folder or .tar.gz), fsync"]
  s6 --> s7["7. verify the backup data folder<br/>against the hashes in memory"]
  s7 --> s8["8. summary + final line,<br/>flush and close the log"]
  s6 & s7 -- "level 2 (fatal)" --> s8
  s8 --> status{"errors?"}
  status -- none --> ok(["finished successfully, code 0"])
  status -- some --> withErrors(["finished WITH ERRORS, code 1"])
  cannotStart(["could not start, code 2"])
```

Ctrl+C at any point: before the log file exists - "could not start: interrupted, code 3";
after - copying or verification stops, the summary and "Backup INTERRUPTED, code 3" are written.
A second Ctrl+C exits at once (no final line - the backup is not valid).

## Copying one file (uncompressed source)

`copier.ts`, `withFileRetries` + `copyOnce`. The hash is computed while reading the source;
the target is created only after the source has been opened.

```mermaid
flowchart TD
  begin(["file from the list"]) --> stat1["stat source (size, mtime)"]
  stat1 --> open["open source, create target 'wx'"]
  open --> loop["read chunk → SHA-256 → write target"]
  loop --> stat2["stat source again"]
  stat2 --> changed{"size or mtime<br/>changed?"}
  changed -- no --> finish["set mtime, fsync, close"]
  finish --> record(["record path, size, SHA-256<br/>(list of copied items)"])
  changed -- yes --> failed
  open & loop -- error --> classify{"error kind"}
  classify -- "destination: disk full, I/O,<br/>disk gone" --> fatal(["level 2: stop the whole run"])
  classify -- "destination: name, size limit,<br/>collision" --> itemError(["level 3: skip the file"])
  classify -- "source: locked, read error" --> available{"source root<br/>still available?"}
  available -- no --> stopSource(["level 3: stop this source,<br/>other sources go on"])
  available -- yes --> failed["delete our unfinished file"]
  failed --> attempts{"attempt < 3?"}
  attempts -- "yes (not for a file that disappeared<br/>or whose unfinished copy could not be deleted)" --> pause["pause ~1 s<br/>(Ctrl+C cuts it short)"] --> stat1
  attempts -- no --> itemError
```

Folders are created as the list is walked (folders come before their content); on Linux and macOS each folder
is flushed to disk after everything inside it has been created.

## Compressed source (`compress: true`)

`archive-source.ts` + `tar-writer.ts`. The archive is written as a chain of gzip members, one per entry,
so a failed entry is rolled back by truncating the file to the last member boundary.

```mermaid
flowchart LR
  create["create NAME.tar.gz 'wx'"] --> entry["entry: remember the boundary"]
  entry --> member["gzip member: pax + ustar headers,<br/>file data, padding"]
  member -- ok --> next{"more entries?"}
  member -- "error" --> truncate["truncate to the boundary<br/>(retry like a plain file)"]
  truncate --> next
  next -- yes --> entry
  next -- no --> tarEnd["tar end as the last member,<br/>fsync, close"]
  tarEnd --> recordArchive(["record archive size + SHA-256,<br/>entries with their SHA-256"])
```

## Verification (step 7)

`verifier.ts` + `tar-reader.ts`. Everything is re-read from the destination; nothing is written to the backup data folder.

```mermaid
flowchart TD
  walk["walk the backup data folder on disk"] --> compare["compare with the list of copied items"]
  compare --> missingExtra["missing / extra / wrong type → mismatch"]
  compare --> plainFile["plain file: re-read, size + SHA-256"]
  compare --> archiveFile["archive: size + SHA-256 of the file,<br/>then extract in memory as a stream"]
  archiveFile --> checks["gzip CRC of each member, tar header checksums,<br/>tar end, SHA-256 of each entry, set of entries"]
  plainFile & checks & missingExtra --> result(["every mismatch is a level 3 error;<br/>verification does not stop at the first one"])
```

## Error levels and the final status

| Level | In code | Effect on the run |
|---|---|---|
| 1 - cannot start | `StartError` | backup data folder not created, "could not start", code 2 |
| 2 - fatal | `FatalError` | copying/verification stops, "WITH ERRORS", code 1 |
| 3 - item error | `RunReport.error()` | item skipped, run goes on, "WITH ERRORS", code 1 |
| 4 - warning | `RunReport.warn()` | logged only, status not affected |
| Ctrl+C | `AbortSignal` → `InterruptedError` | "INTERRUPTED" (or "could not start: interrupted"), code 3 |

The status of a backup exists **only in its log `backup-<start time>.log`**: a backup is valid only if its log ends with
"Backup finished successfully".
