// Temporary folders for tests (AGENTS.md, "Test data").
//
// All temporary folders are created under one test base folder: AF_BACKUP_TEST_DIR, or os.tmpdir()
// if it is not set. The base folder is created if missing and is never deleted by tests.

import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export function testBaseDirectory(): string {
  const fromEnvironment = process.env['AF_BACKUP_TEST_DIR'];

  return fromEnvironment ? path.resolve(fromEnvironment) : os.tmpdir();
}

/** Creates a new temporary folder under the test base folder; `cleanup` deletes it (and only it). */
export async function makeTemporaryDirectory(prefix = 'af-backup-test-'): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const base = testBaseDirectory();
  await fsPromises.mkdir(base, { recursive: true });
  const directory = await fsPromises.mkdtemp(path.join(base, prefix));

  return {
    directory,
    cleanup: () => fsPromises.rm(directory, { recursive: true, force: true, maxRetries: 10 }),
  };
}

/** Writes files described as { 'a/b.txt': 'content' }; a key ending with '/' creates a folder. */
export async function writeTree(root: string, tree: Record<string, string | Buffer>): Promise<void> {
  for (const [relativePath, content] of Object.entries(tree)) {
    const absolutePath = path.join(root, ...relativePath.split('/').filter(Boolean));

    if (relativePath.endsWith('/')) {
      await fsPromises.mkdir(absolutePath, { recursive: true });
    } else {
      await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
      await fsPromises.writeFile(absolutePath, content);
    }
  }
}
