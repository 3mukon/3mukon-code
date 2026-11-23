import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { Accounts, usageStorage } from '../../accounts/main/accounts';
import { windowAccountsUi } from '../../accounts/main/native';
import type { AccountSource } from '../../accounts/main/source';
import { dockAttention } from '../../approvals/main/dock';
import { stagedChromeConnection } from '../../browser/main/chrome-profile-installation';
import { installedChromeVersion } from '../../browser/main/chrome-version';
import { ElectronEmbeddedEngine } from '../../browser/main/electron';
import { BrowserViewHost } from '../../browser/main/view-host';
import { nativeHelper } from '../../computer/main/launch-helper';
import { FileService } from '../../files/main/files';
import { keepUnsavedChanges, windowFilesUi } from '../../files/main/native';
import { switchableTranslator } from '../../i18n/main/i18n';
import { resolveLanguage } from '../../i18n/shared/language';
import { PresentationHost } from '../../panels/main/presentation-host';
import { ARTIFACT_LIMITS, PRESENTATION_LIMITS } from '../../panels/shared/presentation';
import { createClaudeCodeProvider } from '../../providers/claude-code/main/adapter';
import { createCodexProvider } from '../../providers/codex/main/adapter';
import { createGrokBuildProvider } from '../../providers/grok-build/main/adapter';
import { choiceStorage, RememberedChoices } from '../../sessions/main/choices';
import { dayRoot } from '../../sessions/main/folders';
import { SessionHost } from '../../sessions/main/host';
import { windowSessionsUi } from '../../sessions/main/native';
import type { Provider } from '../../sessions/main/provider';
import { inboxStorage, SessionInboxes } from '../../sessions/main/inbox';
import type { SessionCoordinator } from '../../sessions/main/provider';
import { recordStorage, SessionRecords } from '../../sessions/main/records';
import { textStorage } from '../../sessions/main/texts';
import { Settings, settingsStorage } from '../../settings/main/settings';
import { preferredLanguages } from '../../settings/shared/settings';
import {
  loginShell,
  spawnPty,
  terminalEnvironment,
  windowTerminalUi,
} from '../../terminal/main/native';
import { Terminals } from '../../terminal/main/terminals';
import { panelTools } from '../../toolset/main/panel-tools';
import type { AutomationTool } from '../../toolset/main/execution';
import { loginShellPath } from './shell-path';
import { startToolset, type RunningToolset } from '../../toolset/main/server';
import { windowWorkspacesUi } from '../../workspaces/main/native';
import { fileStorage } from '../../workspaces/main/storage';
import { Workspaces } from '../../workspaces/main/workspaces';
import { serveBridge } from './bridge';
import { automationUi } from './automation-ui';
import { EMBEDDED_PROFILE } from '../../browser/main/embedded';
import { embeddedBrowser } from './browser-automation';
import { computerAutomation } from './computer-automation';
import { ForegroundControlWindow } from './control-window';
import { UserSetup } from './user-setup';

import { windowPrompts } from './prompts';
import { createMainWindow, pageUrl } from './window';

// How long quitting waits for the sessions, the providers' other processes and the toolset to close.
const CLOSE_TIMEOUT_MS = 5_000;
// How long after the app opens its search starts catching up on the sessions it has no text for,
// so that it leaves the providers alone while the window opens (ADR-0014).
const CATCH_UP_AFTER_MS = 10_000;
// How long after the app opens it reads the providers' sign-ins and usage limits, once the window's
// own requests, such as the models' lists, are under way (ADR-0017).
const ACCOUNTS_AFTER_MS = 5_000;

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
    // Opened from the Finder, a packaged app has macOS's minimal PATH, so it takes the login shell's,
    // which the agents' commands and the providers' tools need (ADR-0019), while the toolset starts.
    const presentations: PresentationHost = new PresentationHost({
      hasOwner: (owner) => toolset?.broker.hasOwner(owner) ?? false,
      file: (_owner, path) => files.presentationPath(path),
      resource: (owner, content) => {
        const target = toolset?.broker.resource(
          owner,
          content.kind === 'browser' ? content.tabId : content.targetId,
        );
        return target &&
          (content.kind === 'browser'
            ? target.ref.kind === 'browser-tab'
            : ['application', 'window'].includes(target.ref.kind))
          ? target.name
          : null;
      },
      notice: (owner, notice) =>
        toolset?.broker.recordPresentation(owner, notice) ?? {
          status: 'refused',
          code: 'not-found',
          dispatched: false,
        },
    });
    const chrome = app.isPackaged
      ? await stagedChromeConnection(process.resourcesPath, data)
      : undefined;
    const embedded = embeddedBrowser(
      new ElectronEmbeddedEngine(),
      () => {
        if (!toolset) throw new Error('The toolset is unavailable.');
        return toolset.broker;
      },
      chrome,
    );
    let controlWindow: ForegroundControlWindow | undefined;
    const helper = nativeHelper({
      data,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged,
      osVersion: process.getSystemVersion(),
      onGenerationEnded: (id) => {
        native.computer.generationEnded(id);
      },
      onControl: (revision, command) => {
        void controlWindow?.command(revision, command);
      },
      onStopShortcut: (registers) => {
        toolset?.broker.configureStopShortcut(registers);
      },
    });
    const native = computerAutomation(
      helper,
      () => {
        if (!toolset) throw new Error('The toolset is unavailable.');
        return toolset.broker;
      },
      (owner, target, signal) =>
        controlWindow?.surface(owner, target, signal) ?? Promise.resolve(undefined),
    );
    // The sessions' coordination, which the toolset's session tools reach once the sessions exist.
    const coordination: { current?: SessionCoordinator } = {};
    const [toolset, shellPath]: [RunningToolset | undefined, string | null] = await Promise.all([
      startToolsetIfPossible(
        version,
        [
          ...panelTools(presentations, {
            artifact: ARTIFACT_LIMITS,
            presentation: PRESENTATION_LIMITS,
          }),
          ...embedded.tools,
          ...native.tools,
        ],
        (owner) => {
          native.computer.closeOwner(owner);
          return embedded.browser.closeOwner(owner);
        },
        (owner) => {
          presentations.removeOwner(owner);
        },
        () => {
          presentations.flushNotices();
        },
        () => coordination.current,
      ),
      app.isPackaged ? loginShellPath(loginShell()) : Promise.resolve(null),
    ]);
    if (shellPath !== null) process.env.PATH = shellPath;
    const adapters = providers(data, version, toolset);
    // The sessions the app starts, kept in its data, which later runs list and resume, with the text
    // of each one's messages, which the lists search.
    const sessions = new SessionHost(
      adapters,
      new SessionRecords(recordStorage(data)),
      textStorage(join(data, 'session-texts')),
      toolset?.sessions,
      new SessionInboxes(inboxStorage(data)),
    );
    coordination.current = sessions.coordinator();
    const automation = automationUi(toolset?.broker, sessions);
    let stopWatchingControl: (() => void) | undefined;
    let stopControlSettings: (() => void) | undefined;
    if (toolset) {
      const broker = toolset.broker;
      const control = new ForegroundControlWindow(new URL('control-window.html', pageUrl()).href, {
        window: ({ sessionId, target }) => native.computer.nativeWindow(sessionId, target),
        name: (owner) => sessions.title(owner) ?? t('panels.sessionPage'),
        language: () =>
          resolveLanguage(preferredLanguages(settings.get().language, systemLanguages)),
        stop: async (owner) => (await automation.stop(owner)).status === 'verified',
        handBack: (owner, target) => broker.handBack(owner, target).status === 'verified',
        draw: (revision, frame) => helper.control(revision, frame),
      });
      controlWindow = control;
      stopWatchingControl = broker.subscribeForegroundControl((state) => {
        control.update(state);
      });
      stopControlSettings = settings.onChange(() => {
        control.refresh();
      });
    }
    // The providers' sign-ins and usage limits, the usage kept in the app's data (ADR-0017).
    const accounts = new Accounts(adapters, usageStorage(data));
    // The terminals the windows open, each running the user's login shell or a sign-in command.
    const terminals = new Terminals(spawnPty, {
      shell: loginShell(),
      home: homedir(),
      env: terminalEnvironment(process.env, app.getLocale()),
    });
    const workspaces = new Workspaces(fileStorage(data));
    // The editors' files: those in the workspaces, and those dropped on a window.
    const files = new FileService(() =>
      workspaces.list().workspaces.map((workspace) => workspace.path),
    );
    // What the settings and the sessions' setup notices show of browser and computer use.
    const setup = new UserSetup({
      appProfileId: EMBEDDED_PROFILE.id,
      installedChromeVersion,
      chrome,
      clearAppSignIns: () => embedded.browser.clearAppSignIns(),
      helper,
      openUrl: (address) => shell.openExternal(address),
    });
    serveBridge({
      presentations,
      browser: embedded.browser,
      computer: {
        preview: (owner, target) => native.computer.preview(owner, target),
        command: (owner, target, command) => native.command(owner, target, command),
      },
      browserViews: new BrowserViewHost(
        embedded.browser,
        (owner, presentation, tab) => presentations.showsBrowser(owner, presentation, tab.id),
        (owner, tab) => toolset?.broker.browserObservationSignal(owner, tab),
      ),
      automation,
      isAuxiliary: (contents) => controlWindow?.owns(contents) ?? false,
      setup,
      workspaces,
      sessions,
      choices: new RememberedChoices(choiceStorage(data), dayRoot(homedir())),
      // Their menus and questions drawn by the window that asked, in the app's own look.
      workspacesUi: (window) => windowWorkspacesUi(window, windowPrompts(window), t),
      sessionsUi: (window) => windowSessionsUi(window, windowPrompts(window), t),
      files,
      filesUi: (window) => windowFilesUi(windowPrompts(window), t),
      settings,
      terminals,
      terminalUi: (window) => windowTerminalUi(windowPrompts(window), t),
      accounts,
      accountsUi: (window) => windowAccountsUi(windowPrompts(window), t),
      page: pageUrl(),
    });
    closeBeforeQuitting(adapters, async () => {
      stopWatchingControl?.();
      stopControlSettings?.();
      controlWindow?.dispose();
      presentations.disconnect();
      terminals.closeAll();
      accounts.close();
      chrome?.close();
      await Promise.allSettled([
        helper.close(),
        sessions.closeAll().finally(async () => {
          await (toolset?.close() ?? Promise.resolve()).finally(() => embedded.browser.close());
        }),
      ]);
    });
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
    const openWindow = () => {
      keepUnsavedChanges(createMainWindow(settings.get()), t);
    };
    openWindow();
    setTimeout(() => {
      void sessions.catchUp();
    }, CATCH_UP_AFTER_MS);
    setTimeout(() => {
      void accounts.readAll();
    }, ACCOUNTS_AFTER_MS);
    // Clicking the Dock icon of a running app without windows opens a new one.
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().some((window) => !controlWindow?.owns(window.webContents)))
        openWindow();
    });
  })
  .catch((error: unknown) => {
    console.error('3mukon-code could not start:', error);
    app.quit();
  });

app.on('window-all-closed', () => {
  // Without this handler Electron quits; a macOS app keeps running until the user quits it.
});

// The app's toolset (ADR-0023), which every Codex session connects to; without it, the app offers no
// Codex sessions, since Codex starts no thread while it cannot reach the toolset.
async function startToolsetIfPossible(
  version: string,
  tools: readonly AutomationTool[],
  onOwnerClosed: (id: string) => Promise<void>,
  onOwnerRemoved: (id: string) => void,
  onDeliveryOpportunity: () => void,
  coordinator: () => SessionCoordinator | undefined,
): Promise<RunningToolset | undefined> {
  try {
    return await startToolset({
      version,
      tools,
      onOwnerClosed,
      onOwnerRemoved,
      onDeliveryOpportunity,
      coordinator,
    });
  } catch (error) {
    console.error('The toolset could not start, so Codex sessions are unavailable:', error);
    return undefined;
  }
}

// The providers, each through its adapter, which also reads its account. Grok Build unpacks its binary
// into a folder of the app's data the first time a session needs it.
function providers(
  data: string,
  version: string,
  toolset: RunningToolset | undefined,
): (Provider & AccountSource)[] {
  return [
    createClaudeCodeProvider(),
    ...(toolset === undefined ? [] : [createCodexProvider({ clientVersion: version })]),
    createGrokBuildProvider({ binaryFolder: join(data, 'grok-build'), clientVersion: version }),
  ];
}

// Closes the sessions, with their provider processes, the providers' other processes, such as those
// listing models or reading an account, and the toolset before the app quits, waiting a few seconds at
// most, after ending the rest at once: the terminals' programs and the accounts' reading.
function closeBeforeQuitting(providers: readonly Provider[], close: () => Promise<void>): void {
  let closing = false;
  app.on('will-quit', (event) => {
    if (closing) return;
    closing = true;
    event.preventDefault();
    const timeout = new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS));
    void Promise.race([
      Promise.allSettled([close(), ...providers.map((provider) => provider.close())]),
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
