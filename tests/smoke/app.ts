import { mkdtempSync, rmSync } from 'node:fs';
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
  return electron.launch({ args: ['.', `--user-data-dir=${data}`, ...args] });
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
