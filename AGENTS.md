# AGENTS.md

Instructions for AI agents working with this repository.

## About the project

**AF Backup** is a console tool for simple personal backups, written in TypeScript for Node.js.

- [docs/spec.md](docs/spec.md) - the complete behavior specification. It is the source of truth:
  if the code and the specification disagree, ask the user which is right instead of silently adjusting one to the other.
- [readme.md](readme.md) - a short user-facing description, a digest of the specification.
- [docs/how-it-works.md](docs/how-it-works.md) - diagrams of how a run works, mapped onto the modules.

## Current state

Implemented and covered by tests; CI is set up for Windows, Linux and macOS × Node 22, 24, 26. Manual checks still to be done:
the first CI run (2026-10-11, commit eb688e1, https://github.com/andrew2020wit/af-backup/actions/runs/38114112306)
failed `npm test` on Node 22 on Ubuntu and macOS (the cause is not known yet: the logs need a GitHub sign-in);
the other 7 jobs passed, including the compatibility step; whether the CI compatibility step finds 7-Zip on all three OSes
(it skips tools that are not installed); the archive compatibility check from the spec
on an archive written by af-backup - `node scripts/tar-gz-compatibility.ts all <work-dir> --af-backup` with the full set
(8 GiB file, 70,000 entries; so far only a small set on Windows 11, 2026-10-11), plus File Explorer on Windows 11,
`tar` on Windows 10, Finder and `tar` on macOS, GNU `tar` on Linux; backup to a FAT32/exFAT flash drive (`EFBIG`, case); pulling out the flash drive during copying;
a disk root as a source on Linux (`lost+found`) and macOS (`.Spotlight-V100`, `.Trashes`, `.fseventsd`) - which
service folders cannot be read (see "Sources" in the spec); Unicode normalization on macOS - names stored
decomposed (NFD): masks with letters like "й" and verification on an HFS+ destination (false "missing"/"extra").
Done: long paths over 260 characters on Windows (2026-10-11, Windows 11, Node 26, an uncompressed source,
a 560-character path).

## Build and tests

Node.js >= 22. Development dependencies only: `typescript`, `@types/node` - do not pull in extra ones.

```
npm install         # once
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit for src/ and scripts/ (scripts/tsconfig.json)
npm test            # build + node:test over dist/**/*.test.js
```

- Tests are `*.test.ts` files next to the code; they run against the built `dist/`.
- Before running tests, set `AF_BACKUP_TEST_DIR` to the session's registered test data folder (see "Test data").
- Temporary folders in tests - only via `makeTemporaryDirectory` (`src/test-support`).
- File system faults are simulated by replacing methods of `fileSystemOperations`
  (`src/services`, `patchFileSystemOperations`);
  production code does all file system work through `fileSystemOperations`. The only exception is
  `src/utilities/version.ts`: it reads the program's own `package.json` with `node:fs` (not user data, not a fault to simulate).

## Structure

```
.github/workflows/
  ci.yml        # typecheck, tests, short crash torture and compatibility check: Windows, Linux, macOS × Node 22, 24, 26
docs/
  spec.md       # behavior specification
  how-it-works.md  # diagrams: modules, the steps of a run, copying, compression, verification
scripts/
  tar-gz-compatibility.ts  # .tar.gz compatibility check (format prototype; all --af-backup checks an archive written by af-backup), run: node scripts/tar-gz-compatibility.ts
  crash-torture.ts  # kill af-backup at random moments and check the invariants (needs npm run build)
src/
  main.ts       # entry point (bin: dist/main.js)
  cli.ts        # arguments → run
  run-pipeline.ts  # the backup run: steps 0-8 (the only command)
  services/     # task, destination, file list, copying, compression, verification, log, file system, tar.gz...
  utilities/    # general helpers: error model, arguments, platform, formatting, escaping for the log, strict JSON, destination folder layout, version
  interfaces/   # TypeScript interfaces (*.interface.ts files)
  test-support/ # helpers for tests
templates/      # what the user copies into a destination folder: windows/, linux/ and macos/, each with
                #   af-backup-task.json and a launcher script (run-af-backup.cmd / .sh / .command)
.gitattributes  # line endings of the launcher scripts: CRLF for .cmd, LF for .sh and .command
readme.md       # short user-facing description; ends with "License and disclaimer"
LICENSE         # MIT License
test-data.md    # local test data registry, not in git (see "Test data")
test-data/      # test data, one subfolder per session, not in git
```

Where a file goes in `src/`: the entry point and the top-level modules (`main.ts`, `cli.ts`, `run-pipeline.ts`)
live in the root of `src/`; helpers live in `src/<kind>/`, by kind of file (`services/`, `utilities/`, `interfaces/`,
`test-support/`).

## Key concepts

Not duplicated here so they do not go stale: task, destination, backup folder statuses, verification
and design goals are described in [docs/spec.md](docs/spec.md).
If something is missing or ambiguous in the specification, do not make it up: discuss it with the user first
and put the decision into the specification.

The documentation must not read as personal obligations of the developer: describe what the tool is designed
to do ("goals", "designed to"), not guarantees or promises. The tool is provided as is, without any warranty
(readme, "License and disclaimer").

## Working rules

- **Everything is in English:** code, identifiers, comments, user-facing messages, documentation
  and commit messages. The only exception is test data whose purpose is non-ASCII content
  (for example, Cyrillic file names in `scripts/tar-gz-compatibility.ts`).
- Code is TypeScript for Node.js, no browser APIs.
- The tool works with real user files: in the destination folder (created by the user, never by the tool) it writes
  only the backup data folder and the log it has created in this run, and deletes only its own unfinished files
  inside that backup data folder; it never deletes or overwrites anything that existed before the run. Never touch sources.
- The tool is cross-platform (Windows, Linux, macOS; development happens on Windows): use `node:path`,
  do not concatenate paths as strings.
- Behavior changes go into `docs/spec.md` first; if they affect what the readme describes
  (commands, task fields, statuses, exit codes), update the readme too.
- When the task format changes, update together: the `Task` interface, the templates in `templates/`, `docs/spec.md` and the readme.
  The `version` field versions the format (`jsonType` only marks the file as a task) - bump `version`
  on incompatible changes.

## Test data

Test data (files and folders created for tests, checks, experiments) must never be left behind unnoticed,
even after a power loss or a crash. For that there is a local registry `test-data.md` in the repository root
(ignored by git; if it is missing, create it from the template below).

- **Before** creating test files or folders, add their paths to `test-data.md`. An entry that is written
  but whose data was never created is harmless; data without an entry is lost track of.
- As a rule, each session puts all its test data into one folder of its own and registers only that folder:
  `test-data/<YYYY-MM-DD_HHmmss>-<short-purpose>/` in the repository root (`test-data/` is ignored by git).
  Never register or delete `test-data/` as a whole: another session may be using it at the same time.
  A scratchpad or temporary folder is fine too, as long as it is registered.
- This also covers data created by tools: for automated tests, set `AF_BACKUP_TEST_DIR` to the session's
  registered folder (tests create their temporary folders there, see `src/test-support`); give
  `scripts/tar-gz-compatibility.ts` and `scripts/crash-torture.ts` a working folder inside it.
- The `(no entries)` line stays only while the list is empty: remove it when adding the first entry
  and put it back after removing the last one.
- After the test data is deleted, remove its entry.
- At the start of work, check `test-data.md`. Entries in it are usually leftovers of an interrupted session,
  but they may also belong to another session running right now. Show the entries to the user and ask
  whether any other session is still using them; delete the data and remove the entries only after the user
  confirms. Delete only what is listed there, and look at the path before deleting (it must be test data,
  never a source or a user folder).

Template for `test-data.md`:

```markdown
# Test data registry

Local file, not tracked by git. Lists test files and folders that were created on this machine
and have not been deleted yet, so that leftovers can be removed after a power loss or a crash.
The rules are in [AGENTS.md](AGENTS.md), section "Test data".

## Entries

An entry is added **before** the data is created and removed after the data is deleted.
Format: `- <absolute path> | <created, YYYY-MM-DD HH:mm> | <what created it and why>`

(no entries)
```
