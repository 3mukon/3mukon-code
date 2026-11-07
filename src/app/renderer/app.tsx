import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountsButton, AccountsPanel } from '../../accounts/renderer/accounts-panel';
import { SignInPrompt, UsageNotice } from '../../accounts/renderer/session-notes';
import { useAccounts } from '../../accounts/renderer/use-accounts';
import { mostUsed } from '../../accounts/shared/accounts';
import { Request } from '../../approvals/renderer/requests';
import { WaitingButton } from '../../approvals/renderer/waiting-button';
import { nextWaiting } from '../../approvals/shared/waiting';
import { useFileEditors } from '../../files/renderer/use-file-editors';
import {
  contentOf,
  folderOf,
  panelsOf,
  sameContent,
  type Panel,
} from '../../panels/renderer/layout';
import { PanelArea, type PanelAreaHandle, type PanelView } from '../../panels/renderer/panel-area';
import { usePanels } from '../../panels/renderer/use-panels';
import type { PanelContent } from '../../panels/shared/panels';
import type { ProviderId } from '../../sessions/shared/events';
import type { SessionAction, SessionSummary } from '../../sessions/shared/sessions';
import { ArchivedButton, ArchivedPanel } from '../../sessions/renderer/archived-panel';
import { SessionPage, type AccountViews } from '../../sessions/renderer/session-page';
import { SessionsSection } from '../../sessions/renderer/sessions-section';
import { statusDots } from '../../sessions/renderer/timeline';
import { preloadOffers } from '../../sessions/renderer/use-offers';
import { useSessions } from '../../sessions/renderer/use-sessions';
import { SettingsPanel } from '../../settings/renderer/settings-panel';
import { useSettings } from '../../settings/renderer/use-settings';
import { TerminalPanel } from '../../terminal/renderer/terminal-panel';
import { TerminalViews } from '../../terminal/renderer/terminal-views';
import { Gear } from '../../ui/renderer/icons';
import { TooltipHost } from '../../ui/renderer/tooltip';
import { useWorkspaces } from '../../workspaces/renderer/use-workspaces';
import type { TreeItem } from '../../workspaces/renderer/workspace-tree';
import { WorkspacesSection } from '../../workspaces/renderer/workspaces-section';
import type { Bridge } from '../shared/bridge';
import { PromptHost } from './prompt-host';

// The window shell: a full-height sidebar, which ⌘B shows and hides, beside the main area. The
// window's top 40px form its title bar, which moves the window, shows no title and has no line
// beneath it: in the sidebar, the row of the window buttons; over the main area, the headers of the
// panels at the top, or an empty strip while none is open. Just after the window buttons, wherever
// they lie, the button of the archived sessions keeps its place, and after it the count of sessions
// waiting on the user shows the one that has waited longest. The sidebar's divider runs through the
// title bar, and while the sidebar is hidden, the window buttons lie over the main area. The sidebar
// holds the Workspaces section above the Sessions section, with a thin line between them; the main
// area holds the panel area, blank until something opens in it. The workspaces' tree rows and the
// Sessions list's rows drag into the panel area, which follows their presses, and tree rows open in
// it from the keyboard. New session opens a session page in the selected workspace's folder, or while
// there is none in the day's folder in ~/3mukon-code; a session in the lists shows in its first
// panel, or opens in one, and so does a file opened from a tree. The lists have a session's history
// read ahead as the user reaches for it, and search through the bridge. A session's menu archives,
// unarchives or removes it, and a removed session's panels close. Session pages and sessions fill
// their panels, titled by the session once it runs, a page going on as its session's page once it
// starts it, and files open in editors, which mark unsaved changes and ask about them before their
// panels close. The archived sessions' button opens their panel, and ⌘, or the gear just after the
// app's name opens the settings' panel; each shows in one panel, which opening it again focuses. The
// gauge between them opens the Accounts panel, the same way, with each provider's sign-in and usage
// limits; a session page marks a provider that is not signed in and offers its sign-in, which runs
// the provider's own command in a terminal, and says beside the context in use when its provider has
// nearly used up a limit. ⌃` opens a terminal beside the focused panel, in that panel's folder, or
// else the selected workspace's, or else the home folder, and a workspace's menu opens one in its
// folder; a terminal's panel closing ends it. The window's language follows the settings. As the
// window opens, it asks for what session pages offer, each provider's models among them, so that a
// page has them when it opens. The menus and questions the main process asks the user show over it, in
// the app's own look.
export function App({ bridge }: { bridge: Bridge }) {
  const { t, i18n } = useTranslation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const workspaces = useWorkspaces(bridge.workspaces);
  const sessions = useSessions(bridge.sessions);
  // The archived session last opened from the archived list, as the list showed it, until the main
  // process gives it among the sessions the window has shown.
  const [opening, setOpening] = useState<SessionSummary | null>(null);
  const settings = useSettings(bridge.settings);
  const accounts = useAccounts(bridge.accounts);
  const [terminalViews] = useState(
    () => new TerminalViews(bridge.terminal, (code) => i18n.t('terminal.exited', { code })),
  );
  const panels = usePanels();
  const area = useRef<PanelAreaHandle>(null);
  // The file editors, whose rendered Markdown opens the files it links to in panels.
  const fileEditors = useFileEditors(bridge.files, {
    onOpenFile: (path) => {
      openItem({ kind: 'file', path });
    },
  });
  // The session whose oldest waiting request takes the keyboard focus, each time the key changes.
  const [requestFocus, setRequestFocus] = useState<{ sessionId: string; key: number } | null>(null);

  const openNewSession = () => {
    const selected = workspaces.workspaces.find(
      (workspace) => workspace.id === workspaces.selectedId,
    );
    const open = (folder: string) => {
      panels.open([{ kind: 'session-page', folder }]);
    };
    if (selected !== undefined) open(selected.path);
    else bridge.sessions.dayFolder().then(open, report);
  };

  // The first panel, in reading order, that shows the session, where a session in the lists shows and
  // its oldest waiting request takes the keyboard focus.
  const sessionPanel = (id: string) =>
    panelsOf(panels.layout).find(
      (panel) => panel.content.kind === 'session' && panel.content.id === id,
    );

  const openSession = (session: SessionSummary) => {
    if (session.archived === true) setOpening(session);
    const shown = sessionPanel(session.id);
    if (shown !== undefined) panels.focus(shown.id);
    else panels.open([{ kind: 'session', id: session.id, folder: session.cwd }]);
  };

  // The archived sessions' panel, or the settings', of which one shows: opening it again focuses it.
  const openOwnPanel = (content: PanelContent) => {
    const shown = panelsOf(panels.layout).find((panel) => sameContent(panel.content, content));
    if (shown !== undefined) panels.focus(shown.id);
    else panels.open([content]);
  };

  // A terminal beside the focused panel, in the folder given, or in the home folder for null.
  const openTerminal = (cwd: string | null) => {
    bridge.terminal.open(cwd).then((terminal) => {
      panels.open([{ kind: 'terminal', id: terminal.id, cwd: terminal.cwd }]);
    }, reportTerminal);
  };

  // The provider's own sign-in command, in a terminal beside the focused panel.
  const signIn = (provider: ProviderId) => {
    bridge.accounts.signIn(provider).then((terminal) => {
      panels.open([{ kind: 'terminal', id: terminal.id, cwd: terminal.cwd }]);
    }, reportTerminal);
  };

  const openAccounts = () => {
    openOwnPanel({ kind: 'accounts' });
  };

  // What session pages show of the providers' accounts.
  const accountViews: AccountViews = {
    signedOut: (provider) => accounts.of(provider)?.signIn.state === 'signed-out',
    signIn: (provider) => <SignInPrompt provider={provider} onSignIn={signIn} />,
    notice: (provider) => {
      const account = accounts.of(provider);
      return mostUsed(account?.usage) === undefined ? null : (
        <UsageNotice account={account} onOpen={openAccounts} />
      );
    },
  };

  // The panels of a session removed from the lists close.
  const afterAction = (session: SessionSummary) => (done: SessionAction | null) => {
    if (done !== 'remove') return;
    for (const panel of panelsOf(panels.layout)) {
      if (panel.content.kind === 'session' && panel.content.id === session.id) {
        panels.close(panel.id);
      }
    }
  };

  // A session's menu, from either list.
  const showSessionMenu = (session: SessionSummary) => {
    bridge.sessions.showMenu(session.id).then(afterAction(session), reportMenu);
  };

  // What an archived session's row does without its menu: unarchive it, or remove it once the user
  // confirms.
  const actOnArchived = (session: SessionSummary, action: SessionAction) => {
    bridge.sessions.act(session.id, action).then(afterAction(session), reportMenu);
  };

  // Reads a session's history ahead of showing it, from either list.
  const readAhead = (session: SessionSummary) => {
    bridge.sessions.preload(session.id).catch(reportReadAhead);
  };

  // Shows a waiting session in its panel, with the focus on its oldest waiting request.
  const showWaiting = (session: SessionSummary) => {
    openSession(session);
    setRequestFocus((previous) => ({ sessionId: session.id, key: (previous?.key ?? 0) + 1 }));
  };

  // Beside the window buttons: the archived sessions' button, the accounts' gauge, the settings' gear,
  // whose panel ⌘, opens too, then the count of sessions waiting on the user, which shows the one that
  // has waited longest.
  const besideWindowButtons = (
    <div className="flex shrink-0 items-center gap-1">
      <ArchivedButton
        count={sessions.archived}
        onOpen={() => {
          openOwnPanel({ kind: 'archived' });
        }}
      />
      <AccountsButton onOpen={openAccounts} />
      <button
        type="button"
        onClick={() => {
          openOwnPanel({ kind: 'settings' });
        }}
        aria-label={t('settings.title')}
        title={t('settings.title')}
        className="grid size-5 shrink-0 place-items-center rounded-md text-faint [-webkit-app-region:no-drag] hover:bg-hover hover:text-ink"
      >
        <Gear className="size-3.5" />
      </button>
      <WaitingButton sessions={sessions.sessions} onShow={showWaiting} />
    </div>
  );

  // What the lists show of a session the window shows: in the Sessions list, or else among the others
  // whose pages the window has shown, archived ones, or as the archived list showed it until then.
  const summaryOf = (id: string): SessionSummary | undefined =>
    sessions.sessions.find((session) => session.id === id) ??
    sessions.shown.find((session) => session.id === id) ??
    (opening?.id === id ? opening : undefined);

  const openItem = (item: TreeItem) => {
    const shown = panelsOf(panels.layout).find(
      (panel) => panel.content.kind === 'file' && panel.content.path === item.path,
    );
    if (item.kind === 'file' && shown !== undefined) panels.focus(shown.id);
    else panels.open([contentOf(item)]);
  };

  const view = (panel: Panel): PanelView => {
    const { content } = panel;
    if (content.kind === 'file') {
      const file = fileEditors.panel(panel.id, content.path);
      return {
        body: file.body,
        unsaved: file.unsaved,
        confirmClose: file.confirmClose,
        ...(file.actions === undefined ? {} : { actions: file.actions }),
      };
    }
    if (content.kind === 'settings') {
      return {
        title: t('settings.title'),
        body: <SettingsPanel settings={settings.settings} onChange={settings.change} />,
      };
    }
    if (content.kind === 'terminal') {
      return {
        title: t('terminal.title'),
        body: <TerminalPanel views={terminalViews} id={content.id} />,
        confirmClose: () => bridge.terminal.confirmClose(content.id),
      };
    }
    if (content.kind === 'accounts') {
      return {
        title: t('accounts.title'),
        body: (
          <AccountsPanel bridge={bridge.accounts} accounts={accounts.accounts} onSignIn={signIn} />
        ),
      };
    }
    if (content.kind === 'archived') {
      return {
        title: t('sessions.archived'),
        detail: t('sessions.archivedPanel.count', { count: sessions.archived }),
        body: (
          <ArchivedPanel
            bridge={bridge.sessions}
            count={sessions.archived}
            onOpenSession={openSession}
            onSessionMenu={showSessionMenu}
            onAct={actOnArchived}
            onReadAhead={readAhead}
          />
        ),
      };
    }
    const sessionId = content.kind === 'session' ? content.id : null;
    const summary = sessionId === null ? undefined : summaryOf(sessionId);
    return {
      ...(summary === undefined
        ? {}
        : {
            title: summary.title ?? t(`providers.${summary.provider}`),
            status: statusDots[summary.status],
            statusLabel: t(`sessions.status.${summary.status}`),
          }),
      body: (
        <SessionPage
          bridge={bridge.sessions}
          folder={content.folder}
          sessionId={sessionId}
          {...(summary === undefined ? {} : { summary })}
          accounts={accountViews}
          {...(sessionId === null
            ? {}
            : {
                renderRequest: (item, place) => (
                  <Request
                    item={item}
                    {...(requestFocus?.sessionId === sessionId &&
                    place.oldestWaiting &&
                    sessionPanel(sessionId)?.id === panel.id
                      ? { focusKey: requestFocus.key }
                      : {})}
                    answering={{
                      approval: (requestId, answer) =>
                        bridge.approvals.answerApproval(sessionId, requestId, answer),
                      question: (requestId, answer) =>
                        bridge.approvals.answerQuestion(sessionId, requestId, answer),
                    }}
                  />
                ),
              })}
          onStarted={(started) => {
            panels.show(panel.id, { kind: 'session', id: started, folder: content.folder });
          }}
        />
      ),
    };
  };

  useEffect(() => {
    preloadOffers(bridge.sessions);
  }, [bridge]);

  // A terminal whose panel has closed ends, with whatever runs in it.
  const shownTerminals = useRef(new Set<string>());
  useEffect(() => {
    const shown = new Set(
      panelsOf(panels.layout).flatMap((panel) =>
        panel.content.kind === 'terminal' ? [panel.content.id] : [],
      ),
    );
    for (const id of shownTerminals.current) {
      if (shown.has(id)) continue;
      terminalViews.dispose(id);
      bridge.terminal.close(id).catch(reportTerminal);
    }
    shownTerminals.current = shown;
  }, [panels.layout, terminalViews, bridge]);

  // ⌃` opens a terminal beside the focused panel, in its folder, or else the selected workspace's,
  // or else the home folder.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const onlyControl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (!onlyControl || event.code !== 'Backquote') return;
      event.preventDefault();
      const focused = panelsOf(panels.layout).find((panel) => panel.id === panels.focusedId);
      const selected = workspaces.workspaces.find(
        (workspace) => workspace.id === workspaces.selectedId,
      );
      openTerminal(
        (focused === undefined ? null : folderOf(focused.content)) ?? selected?.path ?? null,
      );
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  // ⇧⌘A shows the request that has waited longest, and the next waiting session's at each press.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shiftCommand = event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey;
      if (!shiftCommand || event.key.toLowerCase() !== 'a') return;
      const focused = panelsOf(panels.layout).find((panel) => panel.id === panels.focusedId);
      const next = nextWaiting(
        sessions.sessions,
        focused?.content.kind === 'session' ? focused.content.id : undefined,
      );
      if (next === undefined) return;
      event.preventDefault();
      showWaiting(next);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  // ⌘, opens the settings' panel, or focuses it.
  useEffect(() => {
    const openSettings = (event: KeyboardEvent) => {
      const onlyCommand = event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
      if (!onlyCommand || event.key !== ',') return;
      event.preventDefault();
      openOwnPanel({ kind: 'settings' });
    };
    window.addEventListener('keydown', openSettings);
    return () => {
      window.removeEventListener('keydown', openSettings);
    };
  });

  useEffect(() => {
    const toggleSidebar = (event: KeyboardEvent) => {
      const onlyCommand = event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
      if (!onlyCommand || event.key.toLowerCase() !== 'b') return;
      event.preventDefault();
      setSidebarOpen((open) => !open);
    };
    window.addEventListener('keydown', toggleSidebar);
    return () => {
      window.removeEventListener('keydown', toggleSidebar);
    };
  }, []);

  return (
    <div className="flex h-full">
      <aside
        aria-label={t('sidebar.label')}
        inert={!sidebarOpen}
        className={`shrink-0 overflow-hidden select-none motion-safe:transition-[width] motion-safe:duration-200 ${sidebarOpen ? 'w-[220px]' : 'w-0'}`}
      >
        <div className="flex h-full w-[220px] flex-col border-r border-line">
          {/* The sidebar's part of the title bar, where macOS draws the traffic lights, with the
              archived sessions' button, the settings' gear and the count of sessions waiting on the
              user just after them; no line separates it from the rest of the sidebar. */}
          <div className="flex h-10 shrink-0 items-center pl-[84px] [-webkit-app-region:drag]">
            {sidebarOpen && besideWindowButtons}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 px-2.5 pb-3.5">
            {/* The app's name, bold and compact, just below the title bar. */}
            <div className="shrink-0 truncate px-2 leading-5 font-bold">3mukon-code</div>
            <WorkspacesSection
              bridge={bridge.workspaces}
              list={workspaces}
              onPressItem={(item, press) => {
                area.current?.dragItem(item, nameOf(item.path), press);
              }}
              onOpenItem={openItem}
              onOpenInTerminal={openTerminal}
            />
            {/* A thin line between the two sections, as wide as their rows, halfway between them. */}
            <div aria-hidden="true" className="-my-1 shrink-0 border-t border-line" />
            <SessionsSection
              sessions={sessions.sessions}
              folders={workspaces.workspaces}
              bridge={bridge.sessions}
              onNewSession={openNewSession}
              onOpenSession={openSession}
              onSessionMenu={showSessionMenu}
              onPressSession={(session, press) => {
                const item = { kind: 'session', id: session.id, folder: session.cwd } as const;
                const title =
                  session.title === undefined || session.title === ''
                    ? t(`providers.${session.provider}`)
                    : session.title;
                area.current?.dragItem(item, title, press);
              }}
              onReadAhead={readAhead}
            />
          </div>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1">
        <PanelArea
          ref={area}
          panels={panels}
          bridge={bridge.panels}
          view={view}
          clearsWindowButtons={!sidebarOpen}
          besideWindowButtons={besideWindowButtons}
        />
      </main>
      <PromptHost bridge={bridge.prompts} />
      <TooltipHost enabled={settings.settings.tooltips} />
    </div>
  );
}

// The last name in a path, as the tree shows a row, or the path itself for the startup disk's root.
function nameOf(path: string): string {
  const name = path.replace(/\/+$/, '').split('/').at(-1);
  return name === undefined || name === '' ? path : name;
}

function report(error: unknown): void {
  console.error('The session page could not open:', error);
}

function reportMenu(error: unknown): void {
  console.error('The session’s menu could not do that:', error);
}

function reportReadAhead(error: unknown): void {
  console.error('The session’s history could not be read ahead:', error);
}

function reportTerminal(error: unknown): void {
  console.error('The terminal could not open:', error);
}
