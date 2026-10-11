// Absolute path rules for paths inside a task (docs/spec.md, "Validation").

import { currentPlatform, pathApi, type PlatformKind } from '../utilities/platform.js';

/** Returns an error text, or null if the path is a valid absolute path for the platform. */
export function checkAbsolutePath(value: string, platform: PlatformKind = currentPlatform): string | null {
  if (value === '') {
    return 'empty path';
  }

  if (value.includes('\0')) {
    return 'path contains a NUL character';
  }

  if (platform === 'posix') {
    if (value.startsWith('/')) {
      return null;
    }

    if (value.startsWith('~')) {
      return `absolute path expected, "~" is not expanded: ${value}`;
    }

    return `absolute path expected: ${value}`;
  }

  if (/^[\\/]{2}[?.][\\/]/.test(value)) {
    return `the \\\\?\\ and \\\\.\\ prefixes are not accepted (long paths work without them): ${value}`;
  }

  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return null;
  }

  if (/^[A-Za-z]:/.test(value)) {
    return `path relative to the current folder of drive ${value.slice(0, 2)} - write ${value.slice(0, 2)}\\...: ${value}`;
  }

  if (/^[\\/]{2}/.test(value)) {
    return /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(value) ? null : `network path must name a server and a share (\\\\server\\share): ${value}`;
  }

  if (/^[\\/]/.test(value)) {
    return `path from the root of the current drive - add a drive letter (C:\\...): ${value}`;
  }

  if (value.startsWith('%') || value.startsWith('~')) {
    return `absolute path expected, "~" and environment variables are not expanded: ${value}`;
  }

  return `absolute path expected (C:\\... or \\\\server\\share\\...): ${value}`;
}

/** Normalizes a valid absolute path (separators, "." and ".." segments, trailing separator). */
export function normalizeAbsolutePath(value: string, platform: PlatformKind = currentPlatform): string {
  return pathApi(platform).resolve(value);
}

/** Whether a normalized absolute path is the root of a drive or a network share (has no "last part"). */
export function isRootPath(normalized: string, platform: PlatformKind = currentPlatform): boolean {
  const pathModule = pathApi(platform);

  return pathModule.parse(normalized).root === normalized || pathModule.basename(normalized) === '';
}
