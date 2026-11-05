import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

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

// The variables a login gives every program, the only ones of the test's own environment that the app
// starts with. Playwright otherwise gives the app the whole of it, which holds the variables of
// whatever runs the tests, and the app passes its environment on to the providers it starts and to
// the terminals' shells. Run from an agent session, such as Claude Code's, they hold that session's
// base URL, account, sockets and tokens, with which a provider could ask its service as the agent's
// host (L-0006).
const LOGIN_VARIABLES = ['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'LANG'];

// The environment of a login: those of the variables that the test's own environment has.
export function loginEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of LOGIN_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

// Launches the built app on the given data folder in a login's environment, with any further
// switches.
export function launch(data: string, ...args: string[]): Promise<ElectronApplication> {
  return shielded(
    electron.launch({ args: ['.', `--user-data-dir=${data}`, ...args], env: loginEnvironment() }),
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
      const follow = () => {
        cover.setBounds(window.getBounds());
      };
      const show = () => {
        follow();
        if (!cover.isVisible()) cover.showInactive();
      };
      if (window.isVisible()) show();
      window.once('ready-to-show', show);
      window.once('show', show);
      window.on('move', follow);
      window.on('resize', follow);
      window.once('closed', () => {
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

// Launches the built app in English on the given data folder in a login's environment, with each
// provider reading its settings from a folder inside it, where it is signed in to nothing, so that no
// test reads the user's accounts or asks the providers' services; and with a terminal's shell reading
// none of the user's own startup files.
export function launchIsolated(data: string): Promise<ElectronApplication> {
  const folders = {
    CLAUDE_CONFIG_DIR: join(data, 'claude'),
    CODEX_HOME: join(data, 'codex'),
    GROK_HOME: join(data, 'grok'),
    ZDOTDIR: join(data, 'zsh'),
  };
  for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
  return shielded(
    electron.launch({
      args: ['.', `--user-data-dir=${data}`, '--lang=en-US'],
      env: { ...loginEnvironment(), ...folders, SHELL: '/bin/zsh' },
    }),
  );
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
