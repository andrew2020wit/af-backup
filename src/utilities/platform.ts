import * as os from 'node:os';
import * as path from 'node:path';
import { formatTimezoneOffset } from './format.js';
import { programVersion } from './version.js';

export type PlatformKind = 'win32' | 'posix';

export const isWindows = process.platform === 'win32';
export const currentPlatform: PlatformKind = isWindows ? 'win32' : 'posix';

/** Case sensitivity of names follows the OS: case-insensitive on Windows and macOS, case-sensitive on Linux. */
export const caseInsensitiveNames = process.platform === 'win32' || process.platform === 'darwin';

export function pathApi(platform: PlatformKind): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Whether `inner` equals `outer` or lies inside it. Both paths must be absolute and normalized
 * (path.resolve). Comparison is always case-insensitive (docs/spec.md, "Overlapping paths").
 */
export function isSameOrInside(inner: string, outer: string, platform: PlatformKind = currentPlatform): boolean {
  const pathModule = pathApi(platform);
  const innerKey = pathModule.resolve(inner).toLowerCase();
  const outerKey = pathModule.resolve(outer).toLowerCase();

  if (innerKey === outerKey) {
    return true;
  }

  const prefix = outerKey.endsWith(pathModule.sep) ? outerKey : outerKey + pathModule.sep;

  return innerKey.startsWith(prefix);
}

export function osDescription(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return process.platform;
  }
}

/** For the first line of a run: "machine X, af-backup 1.1.0, Node 22.x, Windows 10.0.26300, time zone +03:00". */
export function environmentDescription(startTime: Date): string {
  return (
    `machine ${os.hostname()}, af-backup ${programVersion()}, Node ${process.versions.node}, ` +
    `${osDescription()} ${os.release()}, time zone ${formatTimezoneOffset(startTime)}`
  );
}
