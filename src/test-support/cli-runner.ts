// Runs the built CLI (dist/main.js) as a child process in a given current folder.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAIN_JS = fileURLToPath(new URL('../main.js', import.meta.url));

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runMain(commandLineArguments: string[], options: { cwd: string }): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN_JS, ...commandLineArguments], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
