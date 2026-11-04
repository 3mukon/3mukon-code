import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Request } from '../../approvals/renderer/requests';
import { WaitingButton } from '../../approvals/renderer/waiting-button';
import { nextWaiting } from '../../approvals/shared/waiting';
import { useFileEditors } from '../../files/renderer/use-file-editors';
import { contentOf, panelsOf, type Panel } from '../../panels/renderer/layout';
import { PanelArea, type PanelAreaHandle, type PanelView } from '../../panels/renderer/panel-area';
import { usePanels } from '../../panels/renderer/use-panels';
import type { SessionSummary } from '../../sessions/shared/sessions';
import { ArchivedSessions } from '../../sessions/renderer/archived-sessions';
import { SessionPage } from '../../sessions/renderer/session-page';
import { SessionsSection } from '../../sessions/renderer/sessions-section';
import { statusDots } from '../../sessions/renderer/timeline';
import { preloadOffers } from '../../sessions/renderer/use-offers';
import { useSessions } from '../../sessions/renderer/use-sessions';
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
// read ahead as the user reaches for it. A session's menu archives, unarchives or removes it, and a
// removed session's panels close. Session pages and sessions fill their panels, titled by the session
// once it runs, a page going on as its session's page once it starts it, and files open in editors,
// which mark unsaved changes and ask about them before their panels close. As the window opens, it
// asks for what session pages offer, each provider's models among them, so that a page has them when
// it opens.
// The menus and questions the main process asks the user show over it, in the app's own look.
export function App({ bridge }: { bridge: Bridge }) {
  const { t } = useTranslation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const workspaces = useWorkspaces(bridge.workspaces);
  const sessions = useSessions(bridge.sessions);
  // The archived session last opened from the archived list, as the list showed it, until the main
  // process gives it among the sessions the window has shown.
  const [opening, setOpening] = useState<SessionSummary | null>(null);
  const panels = usePanels();
  const area = useRef<PanelAreaHandle>(null);
  const fileEditors = useFileEditors(bridge.files);
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

  // A session's menu, from either list; the panels of a session removed from the lists close.
  const showSessionMenu = (session: SessionSummary) => {
    bridge.sessions.showMenu(session.id).then((done) => {
      if (done !== 'remove') return;
      for (const panel of panelsOf(panels.layout)) {
        if (panel.content.kind === 'session' && panel.content.id === session.id) {
          panels.close(panel.id);
        }
      }
    }, reportMenu);
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

  // Beside the window buttons: the archived sessions' button, then the count of sessions waiting on
  // the user, which shows the one that has waited longest.
  const besideWindowButtons = (
    <div className="flex shrink-0 items-center gap-1">
      <ArchivedSessions
        bridge={bridge.sessions}
        count={sessions.archived}
        onOpenSession={openSession}
        onSessionMenu={showSessionMenu}
        onReadAhead={readAhead}
      />
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
      return { body: file.body, unsaved: file.unsaved, confirmClose: file.confirmClose };
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
              archived sessions' button and the count of sessions waiting on the user just after
              them; no line separates it from the rest of the sidebar. */}
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
            />
            {/* A thin line between the two sections, as wide as their rows, halfway between them. */}
            <div aria-hidden="true" className="-my-1 shrink-0 border-t border-line" />
            <SessionsSection
              sessions={sessions.sessions}
              folders={workspaces.workspaces}
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
