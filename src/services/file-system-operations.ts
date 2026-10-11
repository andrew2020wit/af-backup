// A thin substitutable layer over node:fs.
//
// All file system operations of the tool go through `fileSystemOperations`. Tests replace single methods
// (see `patchFileSystemOperations`) to cause EBUSY, ENOSPC, EIO, a lost disk or a "crash" at any point.

import type { BigIntStats, Dirent, StatsFs } from 'node:fs';
import * as fsPromises from 'node:fs/promises';

export type FileHandle = fsPromises.FileHandle;

export interface FileSystemOperations {
  open(path: string, flags: string, mode?: number): Promise<FileHandle>;
  mkdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirBuffer(path: string): Promise<Dirent<Buffer>[]>;
  lstat(path: string): Promise<BigIntStats>;
  stat(path: string): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  statfs(path: string): Promise<StatsFs>;
  readFile(path: string): Promise<Buffer>;
}

const realFileSystemOperations: FileSystemOperations = {
  open: (path, flags, mode) => fsPromises.open(path, flags, mode),
  mkdir: async (path) => {
    await fsPromises.mkdir(path);
  },
  unlink: (path) => fsPromises.unlink(path),
  readdir: (path) => fsPromises.readdir(path),
  readdirBuffer: (path) => fsPromises.readdir(path, { withFileTypes: true, encoding: 'buffer' }),
  lstat: (path) => fsPromises.lstat(path, { bigint: true }),
  stat: (path) => fsPromises.stat(path, { bigint: true }),
  realpath: (path) => fsPromises.realpath(path),
  readlink: (path) => fsPromises.readlink(path),
  statfs: (path) => fsPromises.statfs(path),
  readFile: (path) => fsPromises.readFile(path),
};

/** The operations used by the tool. Methods may be replaced by tests; production code never does it. */
export const fileSystemOperations: FileSystemOperations = { ...realFileSystemOperations };

/** Replaces some methods of `fileSystemOperations`; returns a function that restores the previous ones. */
export function patchFileSystemOperations(overrides: Partial<FileSystemOperations>): () => void {
  const saved: Partial<FileSystemOperations> = {};

  for (const key of Object.keys(overrides) as (keyof FileSystemOperations)[]) {
    (saved as Record<string, unknown>)[key] = fileSystemOperations[key];
    (fileSystemOperations as unknown as Record<string, unknown>)[key] = overrides[key];
  }

  return () => Object.assign(fileSystemOperations, saved);
}

export function resetFileSystemOperations(): void {
  Object.assign(fileSystemOperations, realFileSystemOperations);
}

/** Creates an error that looks like one from node:fs. */
export function fileSystemError(code: string, syscall: string, path?: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: simulated error, ${syscall}${path ? ` '${path}'` : ''}`);
  error.code = code;
  error.syscall = syscall;

  if (path !== undefined) {
    error.path = path;
  }

  return error;
}
