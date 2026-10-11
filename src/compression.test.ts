import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { after, afterEach, before, test } from 'node:test';
import { fileSystemError, fileSystemOperations, patchFileSystemOperations, resetFileSystemOperations } from './services/file-system-operations.js';
import { createScenario } from './test-support/scenario.js';
import { makeTemporaryDirectory } from './test-support/test-directory.js';
import { copySettings } from './services/copier.js';

let root: string;
let cleanup: () => Promise<void>;

before(async () => {
  ({ directory: root, cleanup } = await makeTemporaryDirectory());
  copySettings.retryPauseMilliseconds = 1;
});

after(() => cleanup());
afterEach(() => resetFileSystemOperations());

const TREE = {
  'a.txt': 'alpha',
  'кириллица/Документ.txt': 'cyrillic',
  'emoji/😀.txt': 'emoji',
  'sub/empty/': '',
  'big.bin': Buffer.alloc(2 * 1024 * 1024 + 17, 3),
  'skip.tmp': 'tmp',
};

const realOpen = fileSystemOperations.open;

test('a compressed source: only the archive in the backup, verified, extracted by external tools', async () => {
  const scenario = await createScenario(root, 'zip', {
    tree: TREE,
    sources: [{ path: path.join(root, 'zip', 'src'), name: 'docs', compress: true }],
  });

  const result = await scenario.run();
  assert.equal(result.code, 0, result.stderr);
  const folder = scenario.dataFolder;
  assert.deepEqual(await fsPromises.readdir(folder), ['docs.tar.gz']);
  assert.match(result.stdout, /Summary: copied 4 files \/ 4 folders \/ .*verification: OK/);

  await checkWithExternalTools(path.join(folder, 'docs.tar.gz'), scenario.source, scenario.base);
});

test('a locked file in a compressed source is rolled back; the archive stays consistent', async () => {
  const scenario = await createScenario(root, 'zip-locked', {
    tree: TREE,
    sources: [{ path: path.join(root, 'zip-locked', 'src'), name: 'docs', compress: true }],
  });

  patchFileSystemOperations({
    open: async (filePath, flags, mode) => {
      const fileHandle = await realOpen(filePath, flags, mode);

      if (!filePath.endsWith('big.bin') || flags !== 'r') {
        return fileHandle;
      }

      let reads = 0;

      return new Proxy(fileHandle, {
        get(target, property) {
          if (property === 'read') {
            return async (...readArguments: Parameters<typeof fileHandle.read>) => {
              if (++reads > 1) {
                throw fileSystemError('EBUSY', 'read'); // fails in the middle of the entry
              }

              return (target.read as (...parameters: unknown[]) => unknown).apply(target, readArguments);
            };
          }

          const value = Reflect.get(target, property);

          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });

  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /docs\.tar\.gz\/big\.bin: the file is locked \(EBUSY\), 3 attempts/);
  // the only error is the skipped file: the archive itself passes verification
  assert.match(result.stdout, /Summary: .*errors 1; verification: OK/);
});

test('EFBIG: archiving stops, the archive is finished with the tar end', async () => {
  const scenario = await createScenario(root, 'zip-efbig', {
    tree: { 'a.txt': 'a', 'b.bin': randomBytes(100_000), 'c.txt': 'c' },
    sources: [{ path: path.join(root, 'zip-efbig', 'src'), name: 'docs', compress: true }],
  });

  patchFileSystemOperations({
    open: async (filePath, flags, mode) => {
      const fileHandle = await realOpen(filePath, flags, mode);

      if (!filePath.endsWith('docs.tar.gz') || flags !== 'wx') {
        return fileHandle;
      }

      return new Proxy(fileHandle, {
        get(target, property) {
          if (property === 'write') {
            return async (buffer: Buffer, offset: number, length: number, position: number) => {
              if (position + length > 2000) {
                throw fileSystemError('EFBIG', 'write');
              }

              return target.write(buffer, offset, length, position);
            };
          }

          const value = Reflect.get(target, property);

          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });

  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /docs\.tar\.gz: the archive exceeded the destination file system limit \(EFBIG\); archiving stopped, 2 files not archived/);
  assert.match(result.stdout, /Summary: .*verification: OK/);
});

test('EFBIG on the tar end: the archive is incomplete, its files are not counted, verification does not check it', async () => {
  const scenario = await createScenario(root, 'zip-efbig-end', {
    tree: { 'a.txt': 'a', 'c.txt': 'c' },
    sources: [{ path: path.join(root, 'zip-efbig-end', 'src'), name: 'docs', compress: true }],
  });

  const isTarEnd = (data: Buffer) => {
    try {
      const unpacked = zlib.gunzipSync(data);

      return unpacked.length === 1024 && unpacked.every((byte) => byte === 0);
    } catch {
      return false;
    }
  };

  patchFileSystemOperations({
    open: async (filePath, flags, mode) => {
      const fileHandle = await realOpen(filePath, flags, mode);

      if (!filePath.endsWith('docs.tar.gz') || flags !== 'wx') {
        return fileHandle;
      }

      return new Proxy(fileHandle, {
        get(target, property) {
          if (property === 'write') {
            return async (buffer: Buffer, offset: number, length: number, position: number) => {
              if (isTarEnd(buffer.subarray(offset, offset + length))) {
                throw fileSystemError('EFBIG', 'write');
              }

              return target.write(buffer, offset, length, position);
            };
          }

          const value = Reflect.get(target, property);

          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });

  const result = await scenario.run();
  resetFileSystemOperations();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /docs\.tar\.gz: the tar end does not fit into the destination file system limit \(EFBIG\) - the archive is incomplete/);
  assert.doesNotMatch(result.stderr, /Verification:|destination disk may be faulty/);
  assert.match(result.stdout, /Summary: copied 0 files \/ 0 folders \/ .*errors 1; verification: OK/);
  assert.deepEqual(await fsPromises.readdir(scenario.dataFolder), ['docs.tar.gz']);
});

/** Changes the archive in the backup right before verification starts walking the backup folder. */
function beforeVerification(scenario: { dataFolder: string }, change: (archive: string) => Promise<void>): void {
  const realReaddir = fileSystemOperations.readdir;

  patchFileSystemOperations({
    readdir: async (directoryPath) => {
      if (directoryPath === scenario.dataFolder) {
        await change(path.join(scenario.dataFolder, 'docs.tar.gz'));
      }

      return realReaddir(directoryPath);
    },
  });
}

test('verification finds a corrupted archive', async () => {
  const scenario = await createScenario(root, 'zip-bad', {
    tree: TREE,
    sources: [{ path: path.join(root, 'zip-bad', 'src'), name: 'docs', compress: true }],
  });

  beforeVerification(scenario, async (archive) => {
    const content = await fsPromises.readFile(archive);
    content[Math.floor(content.length / 3)]! ^= 0x55;
    await fsPromises.writeFile(archive, content);
  });

  const result = await scenario.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Verification: content does not match \(SHA-256\): docs\.tar\.gz/);
});

test('verification: a missing archive is reported once, its content items are not reported', async () => {
  const scenario = await createScenario(root, 'zip-gone', {
    tree: TREE,
    sources: [{ path: path.join(root, 'zip-gone', 'src'), name: 'docs', compress: true }],
  });

  beforeVerification(scenario, (archive) => fsPromises.rm(archive));
  const result = await scenario.run();
  assert.equal(result.code, 1);
  const mismatches = result.stderr.split('\n').filter((line) => line.includes('Verification: '));
  assert.equal(mismatches.length, 1, result.stderr);
  assert.match(mismatches[0]!, /Verification: missing file: docs\.tar\.gz$/);
});

const EXPECTED = ['a.txt', 'кириллица/Документ.txt', 'emoji/😀.txt', 'big.bin'];

const PYTHON_EXTRACT = [
  'import sys, tarfile',
  "with tarfile.open(sys.argv[1], 'r:gz') as t:",
  "    try: t.extractall(sys.argv[2], filter='fully_trusted')",
  '    except TypeError: t.extractall(sys.argv[2])',
].join('\n');

/**
 * Archives written by af-backup are extracted by external tools:
 * tar (GNU or bsdtar), Python tarfile, gzip -t. Tools that are not installed are skipped.
 */
async function checkWithExternalTools(archive: string, source: string, base: string): Promise<void> {
  const sha256OfFile = async (file: string) => createHash('sha256').update(await fsPromises.readFile(file)).digest('hex');

  const compare = async (extracted: string, skipEmoji: boolean) => {
    for (const file of EXPECTED) {
      if (skipEmoji && file.includes('😀')) {
        continue;
      }

      assert.equal(await sha256OfFile(path.join(extracted, ...file.split('/'))), await sha256OfFile(path.join(source, ...file.split('/'))), `${extracted}: ${file}`);
    }

    assert.ok((await fsPromises.stat(path.join(extracted, 'sub', 'empty'))).isDirectory(), 'empty folder');
  };

  const run = (command: string, commandArguments: string[]) => spawnSync(command, commandArguments, { encoding: 'utf8', windowsHide: true });
  let extractionCount = 0;

  const extractionDirectory = async () => {
    const extracted = path.join(base, `extract-${++extractionCount}`);
    await fsPromises.mkdir(extracted);

    return extracted;
  };

  const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';

  if (process.platform !== 'win32' || fs.existsSync(tar)) {
    const extracted = await extractionDirectory();
    const result = run(tar, ['-xzf', archive, '-C', extracted]);

    // the built-in Windows tar (bsdtar) skips names with emoji (docs/spec.md, "Compression"), the rest must match
    if (process.platform !== 'win32') {
      assert.equal(result.status, 0, result.stderr);
    }

    await compare(extracted, process.platform === 'win32');
  }

  for (const python of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const versionCheck = run(python, ['-c', 'import tarfile; print("ok")']);

    if (versionCheck.status !== 0 || !versionCheck.stdout.includes('ok')) {
      continue;
    }

    const extracted = await extractionDirectory();
    const result = run(python, ['-c', PYTHON_EXTRACT, archive, extracted]);
    assert.equal(result.status, 0, result.stderr);
    await compare(extracted, false);
    break;
  }

  if (process.platform !== 'win32') {
    const result = run('gzip', ['-t', archive]);

    if (!result.error) {
      assert.equal(result.status, 0, result.stderr);
    }
  }
}
