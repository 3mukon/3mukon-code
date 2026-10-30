import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { FileService } from '../../files/main/files';
import { keepUnsavedChanges, nativeFilesUi } from '../../files/main/native';
import { mainTranslator } from '../../i18n/main/i18n';
import { createClaudeCodeProvider } from '../../providers/claude-code/main/adapter';
import { createCodexProvider } from '../../providers/codex/main/adapter';
import { createGrokBuildProvider } from '../../providers/grok-build/main/adapter';
import { choiceStorage, RememberedChoices } from '../../sessions/main/choices';
import { dayRoot } from '../../sessions/main/folders';
import { SessionHost } from '../../sessions/main/host';
import { nativeSessionsUi } from '../../sessions/main/native';
import type { Provider } from '../../sessions/main/provider';
import { startToolset, type RunningToolset } from '../../toolset/main/server';
import { nativeWorkspacesUi } from '../../workspaces/main/native';
import { fileStorage } from '../../workspaces/main/storage';
import { Workspaces } from '../../workspaces/main/workspaces';
import { serveBridge } from './bridge';
import { createMainWindow, pageUrl } from './window';

// How long quitting waits for the sessions and the toolset to close.
const CLOSE_TIMEOUT_MS = 5_000;

void app
  .whenReady()
  .then(async () => {
    const data = app.getPath('userData');
    const version = app.getVersion();
    // The locale comes first, so that a --lang switch, which the smoke tests pass, applies to the main
    // process's strings as it does to the window's.
    const t = mainTranslator([app.getLocale(), ...app.getPreferredSystemLanguages()]);
    const toolset = await startToolsetIfPossible(version);
    const sessions = new SessionHost(providers(data, version, toolset));
    const workspaces = new Workspaces(fileStorage(data));
    // The editors' files: those in the workspaces, and those dropped on a window.
    const files = new FileService(() =>
      workspaces.list().workspaces.map((workspace) => workspace.path),
    );
    serveBridge({
      workspaces,
      sessions,
      choices: new RememberedChoices(choiceStorage(data), dayRoot(homedir())),
      workspacesUi: (window) => nativeWorkspacesUi(window, t),
      sessionsUi: (window) => nativeSessionsUi(window, t),
      files,
      filesUi: (window) => nativeFilesUi(window, t),
      page: pageUrl(),
    });
    closeBeforeQuitting(sessions, toolset);
    // A window whose editors hold unsaved changes asks before it closes.
    app.on('browser-window-created', (_event, window) => {
      keepUnsavedChanges(window, t);
    });

    createMainWindow();
    // Clicking the Dock icon of a running app without windows opens a new one.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  })
  .catch((error: unknown) => {
    console.error('3mukon-code could not start:', error);
    app.quit();
  });

app.on('window-all-closed', () => {
  // Without this handler Electron quits; a macOS app keeps running until the user quits it.
});

// The app's toolset (ADR-0009), which Codex's sessions ask their questions through; without it, the
// app offers no Codex sessions.
async function startToolsetIfPossible(version: string): Promise<RunningToolset | undefined> {
  try {
    return await startToolset({ version });
  } catch (error) {
    console.error('The toolset could not start, so Codex sessions are unavailable:', error);
    return undefined;
  }
}

// The providers, each through its adapter. Grok Build unpacks its binary into a folder of the app's
// data the first time a session needs it.
function providers(data: string, version: string, toolset: RunningToolset | undefined): Provider[] {
  return [
    createClaudeCodeProvider(),
    ...(toolset === undefined ? [] : [createCodexProvider({ toolset, clientVersion: version })]),
    createGrokBuildProvider({ binaryFolder: join(data, 'grok-build'), clientVersion: version }),
  ];
}

// Closes the sessions, with their provider processes, and the toolset before the app quits, waiting
// a few seconds at most.
function closeBeforeQuitting(sessions: SessionHost, toolset: RunningToolset | undefined): void {
  let closing = false;
  app.on('will-quit', (event) => {
    if (closing) return;
    closing = true;
    event.preventDefault();
    const timeout = new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS));
    void Promise.race([
      Promise.allSettled([sessions.closeAll(), toolset?.close()]),
      timeout,
    ]).finally(() => {
      // Electron ignores a quit asked for while it still handles the one held back here, which it
      // does until this event loop turn ends, so the app asks again on a later one.
      setImmediate(() => {
        app.quit();
      });
    });
  });
}
