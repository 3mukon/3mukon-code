import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication } from '@playwright/test';

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

// Stands in for the user in the native folder picker and trust question, which a test cannot click:
// the picker chooses the folder, and the question gets the answer.
export async function answerDialogs(app: ElectronApplication, folder: string, trust: boolean) {
  await app.evaluate(
    ({ dialog }, { folder, trust }) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] });
      dialog.showMessageBox = () =>
        Promise.resolve({ response: trust ? 0 : 1, checkboxChecked: false });
    },
    { folder, trust },
  );
}
