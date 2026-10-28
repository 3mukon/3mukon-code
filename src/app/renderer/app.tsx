import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { writeItemDrag } from '../../panels/renderer/item-drag';
import { contentOf } from '../../panels/renderer/layout';
import { PanelArea } from '../../panels/renderer/panel-area';
import { usePanels } from '../../panels/renderer/use-panels';
import { SessionsSection } from '../../sessions/renderer/sessions-section';
import { useSessions } from '../../sessions/renderer/use-sessions';
import { useWorkspaces } from '../../workspaces/renderer/use-workspaces';
import { WorkspacesSection } from '../../workspaces/renderer/workspaces-section';
import type { Bridge } from '../shared/bridge';

// The window shell: a full-height sidebar, which ⌘B shows and hides, beside the main area. The
// window's top 40px form its title bar, which moves the window, shows no title and has no line
// beneath it: in the sidebar, the row of the window buttons; over the main area, the headers of the
// panels at the top, or an empty strip while none is open. The sidebar's divider runs through it, and
// while the sidebar is hidden, the window buttons lie over the main area. The sidebar holds the
// Workspaces section above the Sessions section, with a thin line between them; the main area holds
// the panel area, blank until something opens in it. The workspaces' tree rows drag into the panel
// area, and open in it from the keyboard.
export function App({ bridge }: { bridge: Bridge }) {
  const { t } = useTranslation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const workspaces = useWorkspaces(bridge.workspaces);
  const sessions = useSessions(bridge.sessions);
  const panels = usePanels();

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
          {/* The sidebar's part of the title bar, where macOS draws the traffic lights; no line
              separates it from the rest of the sidebar. */}
          <div className="h-10 shrink-0 [-webkit-app-region:drag]" />
          <div className="flex min-h-0 flex-1 flex-col gap-4 px-2.5 pb-3.5">
            {/* The app's name, bold and compact, just below the title bar. */}
            <div className="shrink-0 truncate px-2 leading-5 font-bold">3mukon-code</div>
            <WorkspacesSection
              bridge={bridge.workspaces}
              list={workspaces}
              onDragItem={(item, dataTransfer) => {
                writeItemDrag(dataTransfer, item);
              }}
              onOpenItem={(item) => {
                panels.open([contentOf(item)]);
              }}
            />
            {/* A thin line between the two sections, as wide as their rows, halfway between them. */}
            <div aria-hidden="true" className="-my-1 shrink-0 border-t border-line" />
            <SessionsSection sessions={sessions} folders={workspaces.workspaces} />
          </div>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1">
        <PanelArea panels={panels} bridge={bridge.panels} clearsWindowButtons={!sidebarOpen} />
      </main>
    </div>
  );
}
