import { readFileSync } from 'node:fs';

let cached: string | undefined;

/** The program version from package.json (dist/utilities/version.js → ../../package.json). */
export function programVersion(): string {
  if (cached === undefined) {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    cached = typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  }

  return cached;
}
