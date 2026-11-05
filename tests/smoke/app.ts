import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Launches the built app on the given data folder, with any further switches.
export function launch(data: string, ...args: string[]): Promise<ElectronApplication> {
  return shielded(electron.launch({ args: ['.', `--user-data-dir=${data}`, ...args] }));
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

// Launches the built app in English on the given data folder, with each provider reading its settings
// from a folder inside it, where it is signed in to nothing, so that no test reads the user's
// accounts or asks the providers' services; and with a terminal's shell reading none of the user's
// own startup files.
export function launchIsolated(data: string): Promise<ElectronApplication> {
  const folders = {
    CLAUDE_CONFIG_DIR: join(data, 'claude'),
    CODEX_HOME: join(data, 'codex'),
    GROK_HOME: join(data, 'grok'),
    ZDOTDIR: join(data, 'zsh'),
  };
  for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  return shielded(
    electron.launch({
      args: ['.', `--user-data-dir=${data}`, '--lang=en-US'],
      env: { ...env, ...folders, SHELL: '/bin/zsh' },
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
