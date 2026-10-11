// "Crash torture": af-backup is killed (SIGKILL) at a random moment,
// then a regular run follows; many times. Checks the main invariants: if the log says "Backup finished successfully"
// for the killed run, the backup is complete (the uncompressed source matches, the archive is complete and intact);
// whatever the killed run left in the destination folder (its backup-data-<start time> or backup-<start time>.log) does not stop
// the regular run started in a later second: it succeeds and does not change the leftover.
//
// Runs without a build of itself (Node.js >= 22.18), but needs the built program: npm run build
//   node scripts/crash-torture.ts <work-dir> [--iterations=50] [--keep]
//
// <work-dir> must not exist or be empty; put it into a registered test data folder (AGENTS.md, "Test data").
// It is deleted at the end unless --keep is given.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_JS = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const TAR_READER_JS = new URL('../dist/services/tar-reader.js', import.meta.url).href;
const PACKED_FILES = 200;
const PLAIN_FILES = 300;

interface RunResult {
  code: number | null;
  stderr: string;
  killed: boolean;
}

function runBackup(destinationFolder: string, killAfterMilliseconds: number | null): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN_JS, destinationFolder], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    let killed = false;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = killAfterMilliseconds === null ? null : setTimeout(() => ((killed = child.kill('SIGKILL')), undefined), killAfterMilliseconds);
    child.on('error', reject);

    child.on('close', (code) => {
      if (timer) {
        clearTimeout(timer);
      }

      resolve({ code, stderr, killed });
    });
  });
}

interface Setup {
  destinationFolder: string;
  plain: string;
}

/** A backup in the destination folder: its backup data folder and its log, either may be missing. */
interface Backup {
  startTime: string;
  dataFolder: string | null;
  logFile: string | null;
}

async function setup(work: string): Promise<Setup> {
  try {
    if ((await fsPromises.readdir(work)).length) {
      throw new Error(`folder is not empty: ${work}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const destinationFolder = path.join(work, 'dest', 'torture');
  const plain = path.join(work, 'src-plain');
  const packed = path.join(work, 'src-packed');

  for (const directory of [destinationFolder, plain, packed]) {
    await fsPromises.mkdir(directory, { recursive: true });
  }

  for (const [root, count] of [
    [plain, PLAIN_FILES],
    [packed, PACKED_FILES],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const directory = path.join(root, `d${i % 10}`);
      await fsPromises.mkdir(directory, { recursive: true });
      await fsPromises.writeFile(path.join(directory, `f${i}.bin`), randomBytes(i % 7 === 0 ? 200_000 : 2_000));
    }
  }

  await fsPromises.writeFile(
    path.join(destinationFolder, 'af-backup-task.json'),
    JSON.stringify({
      jsonType: 'af-backup-task',
      version: 1,
      sources: [
        { path: plain, name: 'plain' },
        { path: packed, name: 'packed', compress: true },
      ],
    }),
  );

  return { destinationFolder, plain };
}

/** The backups in the destination folder by start time, oldest first. */
async function listBackups(destinationFolder: string): Promise<Backup[]> {
  const backups = new Map<string, Backup>();

  for (const name of await fsPromises.readdir(destinationFolder)) {
    const match = /^backup-data-(\d{4}(?:-\d\d){5})$/.exec(name) ?? /^backup-(\d{4}(?:-\d\d){5})\.log$/.exec(name);

    if (!match) {
      continue;
    }

    const startTime = match[1]!;
    const backup = backups.get(startTime) ?? { startTime, dataFolder: null, logFile: null };
    const targetPath = path.join(destinationFolder, name);

    if (name.endsWith('.log')) {
      backup.logFile = targetPath;
    } else {
      backup.dataFolder = targetPath;
    }

    backups.set(startTime, backup);
  }

  return [...backups.values()].sort((first, second) => first.startTime.localeCompare(second.startTime));
}

async function readLog(logFile: string | null): Promise<string> {
  return logFile ? fsPromises.readFile(logFile, 'utf8').catch(() => '') : '';
}

/** Waits until the next second begins: a run started then gets a start time different from the previous run. */
async function waitForNextSecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 50));
}

/** Problems of a backup that the log calls successful: it must be complete. */
async function backupProblems(context: Setup, dataFolder: string | null): Promise<string[]> {
  const problems: string[] = [];

  if (!dataFolder) {
    problems.push('there is no backup data folder');

    return problems;
  }

  const names = (await fsPromises.readdir(dataFolder)).sort();

  if (names.join() !== 'packed.tar.gz,plain') {
    problems.push(`unexpected content of the backup data folder: ${names.join(', ')}`);

    return problems;
  }

  for (let i = 0; i < PLAIN_FILES; i++) {
    const relativePath = path.join(`d${i % 10}`, `f${i}.bin`);
    const [copy, original] = await Promise.all([
      fsPromises.readFile(path.join(dataFolder, 'plain', relativePath)).catch(() => null),
      fsPromises.readFile(path.join(context.plain, relativePath)),
    ]);

    if (!copy || !copy.equals(original)) {
      problems.push(`plain/${relativePath.replaceAll('\\', '/')} is missing or differs from the source`);
    }
  }

  const { scanTarGz } = (await import(TAR_READER_JS)) as typeof import('../src/services/tar-reader.js');
  const scan = await scanTarGz(path.join(dataFolder, 'packed.tar.gz'), new AbortController().signal);
  const files = scan.entries.filter((entry) => entry.type === 'file').length;

  if (scan.problems.length || !scan.ended || files !== PACKED_FILES) {
    problems.push(`packed.tar.gz is not complete: ${files} files, ended ${scan.ended}, ${scan.problems.join('; ')}`);
  }

  return problems;
}

async function main(): Promise<number> {
  const commandLineArguments = process.argv.slice(2);
  const work = commandLineArguments.find((argument) => !argument.startsWith('--'));

  if (!work) {
    console.log('Usage: node scripts/crash-torture.ts <work-dir> [--iterations=50] [--keep]');

    return 2;
  }

  const iterations = Number(commandLineArguments.find((argument) => argument.startsWith('--iterations='))?.split('=')[1] ?? 50);
  const keep = commandLineArguments.includes('--keep');
  const workDirectory = path.resolve(work);
  const context = await setup(workDirectory);
  const clear = async () => {
    for (const backup of await listBackups(context.destinationFolder)) {
      for (const targetPath of [backup.dataFolder, backup.logFile]) {
        if (targetPath) {
          await fsPromises.rm(targetPath, { recursive: true, force: true, maxRetries: 10 });
        }
      }
    }
  };

  const startTimestamp = Date.now();
  const first = await runBackup(context.destinationFolder, null);

  if (first.code !== 0) {
    throw new Error(`the first run failed (${first.code}): ${first.stderr}`);
  }

  const normalMilliseconds = Date.now() - startTimestamp;
  await clear();
  console.log(`Normal run: ${normalMilliseconds} ms; ${iterations} iterations of kill + regular run`);

  const violations: string[] = [];

  for (let i = 1; i <= iterations; i++) {
    const killAt = Math.floor(Math.random() * normalMilliseconds * 1.5);
    const killedRun = await runBackup(context.destinationFolder, killAt);
    // everything is cleared after each iteration: what is there now was left by the killed run
    const leftover = (await listBackups(context.destinationFolder))[0] ?? null;
    const leftoverLog = await readLog(leftover?.logFile ?? null);
    const succeeded = / Backup finished successfully: /.test(leftoverLog);

    if (succeeded) {
      for (const problem of await backupProblems(context, leftover?.dataFolder ?? null)) {
        violations.push(`iteration ${i}: the log says "finished successfully", but ${problem}`);
      }
    }

    await waitForNextSecond();
    const result = await runBackup(context.destinationFolder, null);

    if (result.code !== 0) {
      violations.push(`iteration ${i}: the regular run ended with code ${result.code}: ${result.stderr.trim()}`);
    }

    if (leftover && (await readLog(leftover.logFile)) !== leftoverLog) {
      violations.push(`iteration ${i}: the regular run changed the log of the killed run`);
    }

    const status = killedRun.killed ? 'killed' : `finished, code ${killedRun.code}`;
    console.log(`  ${i}/${iterations}: killed after ${killAt} ms (${status}), log: ${succeeded ? 'success' : 'no success line'}, then code ${result.code}`);
    await clear();
  }

  if (!keep) {
    await fsPromises.rm(workDirectory, { recursive: true, force: true, maxRetries: 10 });
  }

  if (violations.length) {
    console.log(`VIOLATIONS: ${violations.length}`);

    for (const violation of violations) {
      console.log(`  - ${violation}`);
    }

    return 1;
  }

  console.log('OK: every backup the log calls successful is complete, no leftover stopped the next run or was changed by it');

  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
