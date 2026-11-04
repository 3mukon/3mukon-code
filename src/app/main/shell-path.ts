import { execFile } from 'node:child_process';

// What the login shell prints around its PATH, so that whatever its startup files print is left out.
const MARK = '__3MUKON_CODE_PATH__';

// How long the login shell has to start and print its PATH.
export const SHELL_PATH_TIMEOUT_MS = 5_000;

// The PATH the user's login shell sets, as an interactive login shell started from macOS's Terminal
// would, read from its own printenv between two marks, so that any shell, fish's included, prints it
// alike (ADR-0019). Only the PATH is read: nothing else of the shell's environment, which may hold
// the credentials a profile exports, reaches the app (invariant 9). Null when the shell fails, takes
// too long or prints none.
export function loginShellPath(
  shell: string,
  timeoutMs = SHELL_PATH_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `echo ${MARK}; /usr/bin/printenv PATH; echo ${MARK}`],
      { timeout: timeoutMs, encoding: 'utf8' },
      (_error, stdout) => {
        resolve(pathIn(stdout));
      },
    );
  });
}

// The PATH between the marks in a shell's output, its absolute folders alone, joined by colons.
export function pathIn(output: string): string | null {
  const parts = output.split(MARK);
  if (parts.length < 3) return null;
  const folders = (parts[1] ?? '')
    .trim()
    .split(':')
    .filter((folder) => folder.startsWith('/'));
  return folders.length === 0 ? null : folders.join(':');
}
