import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { LOGIN_VARIABLES } from '../login-variables';

// A throwaway data folder for the app, so that smoke tests never read or change the user's own.
export function dataFolder(): { path: string; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), '3mukon-code-smoke-'));
  return {
    path,
    remove: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

// The environment of a login, the only part of the test's own environment that the app starts with,
// since Playwright otherwise gives the app the whole of it: those of a login's variables that the
// test's environment has (L-0006).
function loginEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of LOGIN_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

// The environment the app under test starts in: a login's, with each provider reading its settings
// from a folder made inside the given throwaway folder, where it is signed in to nothing, and a
// terminal's shell reading none of the user's own startup files. The app runs the providers of its
// own accord, listing their models as its window opens and reading their accounts five seconds later,
// so every test runs them, whatever it tests; in a login's environment alone they would read the
// user's own settings, and with them the user's sign-ins, with which they ask their services, and the
// user's sessions (L-0007).
export function isolatedEnvironment(folder: string): Record<string, string> {
  const folders = {
    CLAUDE_CONFIG_DIR: join(folder, 'claude'),
    CODEX_HOME: join(folder, 'codex'),
    GROK_HOME: join(folder, 'grok'),
    ZDOTDIR: join(folder, 'zsh'),
  };
  for (const made of Object.values(folders)) mkdirSync(made, { recursive: true });
  return { ...loginEnvironment(), ...folders, SHELL: '/bin/zsh' };
}

// Launches the built app on the given data folder in the isolated environment, with any further
// switches, such as the language's. Every smoke test launches the app through this function or
// `launchWith`, which lay a shield over its windows, even a test that only clicks, since a click of the
// Mac's own would otherwise reach it too; the lint refuses Playwright's launcher anywhere else in the
// smoke tests (L-0004).
export function launch(data: string, ...args: string[]): Promise<ElectronApplication> {
  return launchWith(data, { args });
}

// What a test can add to a launch: further switches; variables added to the isolated environment,
// such as those that send a provider's requests to a test's own service; and `colorScheme: null`, for
// a page that follows macOS's appearance as the app sets it, which Playwright otherwise holds at light.
export interface LaunchOptions {
  // The executable of a packaged test copy. The default is the development build.
  executablePath?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  colorScheme?: null;
}

// Launches the built app as `launch` does, with the given options.
export function launchWith(data: string, options: LaunchOptions): Promise<ElectronApplication> {
  return shielded(
    electron.launch({
      executablePath: options.executablePath,
      args: [
        ...(options.executablePath ? [] : ['.']),
        `--user-data-dir=${data}`,
        ...(options.args ?? []),
      ],
      env: { ...isolatedEnvironment(data), ...options.env },
      ...(options.colorScheme === null ? { colorScheme: null } : {}),
    }),
  );
}

// The launched app, each of whose windows lies under a shield, so that the pointer a test drives is
// the only one its page hears. Chromium hears the Mac's own cursor over a window even when the
// window ignores the mouse: as the cursor moves over it, and as the window shows, moves or hides
// under the cursor at rest. The cursor then moves the page's one pointer just as the test's input
// does, taking it off what the test hovers and ending the test's drags with the button up (L-0004).
// The shield, a transparent window over the app's window, with no page and taking no focus, takes
// the cursor instead, while the test's input reaches the page through the DevTools protocol. It
// shows as the window becomes ready to show, just before the app shows the window, and follows it
// as it moves and resizes.
async function shielded(launching: Promise<ElectronApplication>): Promise<ElectronApplication> {
  const app = await launching;
  await app.evaluate(({ app: electronApp, BaseWindow, BrowserWindow }) => {
    const shield = (window: Electron.BrowserWindow) => {
      const cover = new BaseWindow({
        parent: window,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        focusable: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
      });
      // Its clicks too, which a transparent window lets through to the window under it.
      cover.setIgnoreMouseEvents(false);
      let active = true;
      const live = () => active && !window.isDestroyed() && !cover.isDestroyed();
      const follow = () => {
        if (!live()) return;
        cover.setBounds(window.getBounds());
      };
      const show = () => {
        if (!live()) return;
        follow();
        if (!cover.isVisible()) cover.showInactive();
      };
      const detach = () => {
        active = false;
        window.removeListener('ready-to-show', show);
        window.removeListener('show', show);
        window.removeListener('move', follow);
        window.removeListener('resize', follow);
      };
      if (window.isVisible()) show();
      window.once('ready-to-show', show);
      window.once('show', show);
      window.on('move', follow);
      window.on('resize', follow);
      // Quitting can close the child first and still deliver a parent's queued show event. Such a
      // callback must not touch the destroyed native child and open Electron's modal error box.
      cover.once('closed', detach);
      window.once('closed', () => {
        detach();
        if (!cover.isDestroyed()) cover.destroy();
      });
    };
    for (const window of BrowserWindow.getAllWindows()) shield(window);
    electronApp.on('browser-window-created', (_event, window) => {
      shield(window);
    });
  });
  return app;
}

// Runs the built app on a throwaway data folder of its own, and closes it afterwards.
export async function withApp(
  run: (app: ElectronApplication) => Promise<void>,
  ...args: string[]
): Promise<void> {
  const data = dataFolder();
  const app = await launch(data.path, ...args);
  try {
    await run(app);
  } finally {
    await app.close();
    data.remove();
  }
}

// The binaries of the providers' processes: Claude Code's, Codex's and Grok Build's.
const PROVIDER_BINARY = /^(claude|codex|grok-.+)$/;

// The ids of the providers' processes the app runs now, for its sessions or to list models or read
// accounts.
export function providerProcesses(app: ElectronApplication): number[] {
  const parent = app.process().pid;
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const [, pid, ppid, command] = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line) ?? [];
      return pid !== undefined &&
        command !== undefined &&
        Number(ppid) === parent &&
        PROVIDER_BINARY.test(basename(command))
        ? [Number(pid)]
        : [];
    });
}

// Those of the processes that still run.
export function stillRunning(pids: readonly number[]): number[] {
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

// Stands in for the user in the native folder picker, which a test cannot click: it chooses the
// folder.
export async function pickFolder(app: ElectronApplication, folder: string) {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] });
  }, folder);
}

// Gives the answer of this label to the question the window asks, as the user would.
export async function answerQuestion(window: Page, label: string) {
  await window.getByRole('alertdialog').getByRole('button', { name: label, exact: true }).click();
}
