import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Request } from '../../approvals/renderer/requests';
import { WaitingButton } from '../../approvals/renderer/waiting-button';
import { nextWaiting } from '../../approvals/shared/waiting';
import { useFileEditors } from '../../files/renderer/use-file-editors';
import { writeItemDrag } from '../../panels/renderer/item-drag';
import { contentOf, panelsOf, type Panel } from '../../panels/renderer/layout';
import { PanelArea, type PanelView } from '../../panels/renderer/panel-area';
import { usePanels } from '../../panels/renderer/use-panels';
import type { SessionSummary } from '../../sessions/shared/sessions';
import { SessionPage } from '../../sessions/renderer/session-page';
import { SessionsSection } from '../../sessions/renderer/sessions-section';
import { statusDots } from '../../sessions/renderer/timeline';
import { preloadOffers } from '../../sessions/renderer/use-offers';
import { useSessions } from '../../sessions/renderer/use-sessions';
import { useWorkspaces } from '../../workspaces/renderer/use-workspaces';
import type { TreeItem } from '../../workspaces/renderer/workspace-tree';
import { WorkspacesSection } from '../../workspaces/renderer/workspaces-section';
import type { Bridge } from '../shared/bridge';

// The window shell: a full-height sidebar, which ⌘B shows and hides, beside the main area. The
// window's top 40px form its title bar, which moves the window, shows no title and has no line
// beneath it: in the sidebar, the row of the window buttons; over the main area, the headers of the
// panels at the top, or an empty strip while none is open. Just after the window buttons, wherever
// they lie, the count of sessions waiting on the user shows the one that has waited longest. The sidebar's divider runs through it, and
// while the sidebar is hidden, the window buttons lie over the main area. The sidebar holds the
// Workspaces section above the Sessions section, with a thin line between them; the main area holds
// the panel area, blank until something opens in it. The workspaces' tree rows drag into the panel
// area, and open in it from the keyboard. New session opens a session page in the selected
// workspace's folder, or while there is none in the day's folder in ~/3mukon-code; a session in the list shows in its
// panel, or opens in one, and so does a file opened from a tree. Session pages and sessions fill their
// panels, titled by the session once it runs, and files open in editors, which mark unsaved changes
// and ask about them before their panels close. As the window opens, it asks for what session pages
// offer, each provider's models among them, so that a page has them when it opens.
export function App({ bridge }: { bridge: Bridge }) {
  const { t } = useTranslation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const workspaces = useWorkspaces(bridge.workspaces);
  const sessions = useSessions(bridge.sessions);
  const panels = usePanels();
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

  const openSession = (session: SessionSummary) => {
    const shown = panelsOf(panels.layout).find(
      (panel) => panel.content.kind === 'session' && panel.content.id === session.id,
    );
    if (shown !== undefined) panels.focus(shown.id);
    else panels.open([{ kind: 'session', id: session.id, folder: session.cwd }]);
  };

  // The count of sessions waiting on the user, beside the window buttons, which shows the one that has
  // waited longest.
  // Shows a waiting session in its panel, with the focus on its oldest waiting request.
  const showWaiting = (session: SessionSummary) => {
    openSession(session);
    setRequestFocus((previous) => ({ sessionId: session.id, key: (previous?.key ?? 0) + 1 }));
  };

  const waitingIndicator = <WaitingButton sessions={sessions} onShow={showWaiting} />;

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
    const summary = sessions.find((session) => session.id === sessionId);
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
                    {...(requestFocus?.sessionId === sessionId && place.oldestWaiting
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
            panels.open([{ kind: 'session', id: started, folder: content.folder }], {
              kind: 'replace',
              panelId: panel.id,
            });
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
        sessions,
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
              count of sessions waiting on the user just after them; no line separates it from the
              rest of the sidebar. */}
          <div className="flex h-10 shrink-0 items-center pl-[84px] [-webkit-app-region:drag]">
            {sidebarOpen && waitingIndicator}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 px-2.5 pb-3.5">
            {/* The app's name, bold and compact, just below the title bar. */}
            <div className="shrink-0 truncate px-2 leading-5 font-bold">3mukon-code</div>
            <WorkspacesSection
              bridge={bridge.workspaces}
              list={workspaces}
              onDragItem={(item, dataTransfer) => {
                writeItemDrag(dataTransfer, item);
              }}
              onOpenItem={openItem}
            />
            {/* A thin line between the two sections, as wide as their rows, halfway between them. */}
            <div aria-hidden="true" className="-my-1 shrink-0 border-t border-line" />
            <SessionsSection
              sessions={sessions}
              folders={workspaces.workspaces}
              onNewSession={openNewSession}
              onOpenSession={openSession}
            />
          </div>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1">
        <PanelArea
          panels={panels}
          bridge={bridge.panels}
          view={view}
          clearsWindowButtons={!sidebarOpen}
          besideWindowButtons={waitingIndicator}
        />
      </main>
    </div>
  );
}

function report(error: unknown): void {
  console.error('The session page could not open:', error);
}
