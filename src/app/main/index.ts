import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { dockAttention } from '../../approvals/main/dock';
import { FileService } from '../../files/main/files';
import { keepUnsavedChanges, windowFilesUi } from '../../files/main/native';
import { switchableTranslator } from '../../i18n/main/i18n';
import { createClaudeCodeProvider } from '../../providers/claude-code/main/adapter';
import { createCodexProvider } from '../../providers/codex/main/adapter';
import { createGrokBuildProvider } from '../../providers/grok-build/main/adapter';
import { choiceStorage, RememberedChoices } from '../../sessions/main/choices';
import { dayRoot } from '../../sessions/main/folders';
import { SessionHost } from '../../sessions/main/host';
import { windowSessionsUi } from '../../sessions/main/native';
import type { Provider } from '../../sessions/main/provider';
import { recordStorage, SessionRecords } from '../../sessions/main/records';
import { textStorage } from '../../sessions/main/texts';
import { Settings, settingsStorage } from '../../settings/main/settings';
import { preferredLanguages } from '../../settings/shared/settings';
import { startToolset, type RunningToolset } from '../../toolset/main/server';
import { windowWorkspacesUi } from '../../workspaces/main/native';
import { fileStorage } from '../../workspaces/main/storage';
import { Workspaces } from '../../workspaces/main/workspaces';
import { serveBridge } from './bridge';

import { windowPrompts } from './prompts';
import { createMainWindow, pageUrl } from './window';

// How long quitting waits for the sessions and the toolset to close.
const CLOSE_TIMEOUT_MS = 5_000;
// How long after the app opens its search starts catching up on the sessions it has no text for,
// so that it leaves the providers alone while the window opens (ADR-0014).
const CATCH_UP_AFTER_MS = 10_000;

void app
  .whenReady()
  .then(async () => {
    const data = app.getPath('userData');
    const version = app.getVersion();
    // The language and the appearance follow the settings, which the settings panel changes. Of the
    // system's languages the locale comes first, so that a --lang switch, which the smoke tests pass,
    // applies to the main process's strings as it does to the window's.
    const settings = new Settings(settingsStorage(data));
    const systemLanguages = [app.getLocale(), ...app.getPreferredSystemLanguages()];
    const translator = switchableTranslator(
      preferredLanguages(settings.get().language, systemLanguages),
    );
    const t = translator.t;
    nativeTheme.themeSource = settings.get().appearance;
    settings.onChange((current) => {
      translator.use(preferredLanguages(current.language, systemLanguages));
      nativeTheme.themeSource = current.appearance;
    });
    const toolset = await startToolsetIfPossible(version);
    // The sessions the app starts, kept in its data, which later runs list and resume, with the text
    // of each one's messages, which the lists search.
    const sessions = new SessionHost(
      providers(data, version, toolset),
      new SessionRecords(recordStorage(data)),
      textStorage(join(data, 'session-texts')),
    );
    const workspaces = new Workspaces(fileStorage(data));
    // The editors' files: those in the workspaces, and those dropped on a window.
    const files = new FileService(() =>
      workspaces.list().workspaces.map((workspace) => workspace.path),
    );
    serveBridge({
      workspaces,
      sessions,
      choices: new RememberedChoices(choiceStorage(data), dayRoot(homedir())),
      // Their menus and questions drawn by the window that asked, in the app's own look.
      workspacesUi: (window) => windowWorkspacesUi(window, windowPrompts(window), t),
      sessionsUi: (window) => windowSessionsUi(window, windowPrompts(window), t),
      files,
      filesUi: (window) => windowFilesUi(windowPrompts(window), t),
      settings,
      page: pageUrl(),
    });
    closeBeforeQuitting(sessions, toolset);
    // The sessions waiting on the user show on the Dock icon too.
    const dock = app.dock;
    if (dock !== undefined) {
      const attention = dockAttention(dock, () => BrowserWindow.getFocusedWindow() !== null);
      sessions.onChange((list) => {
        attention(list.sessions);
      });
    }
    // A packaged app's bundle carries its icon; unpackaged, the app shows it in the Dock itself.
    if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'resources', 'dock-icon.png'));
    // A window whose editors hold unsaved changes asks before it closes.
    app.on('browser-window-created', (_event, window) => {
      keepUnsavedChanges(window, t);
    });

    createMainWindow(settings.get());
    setTimeout(() => {
      void sessions.catchUp();
    }, CATCH_UP_AFTER_MS);
    // Clicking the Dock icon of a running app without windows opens a new one.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow(settings.get());
    });
  })
  .catch((error: unknown) => {
    console.error('3mukon-code could not start:', error);
    app.quit();
  });

app.on('window-all-closed', () => {
  // Without this handler Electron quits; a macOS app keeps running until the user quits it.
});

// The app's toolset (ADR-0012), which every Codex session connects to; without it, the app offers no
// Codex sessions, since Codex starts no thread while it cannot reach the toolset.
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
