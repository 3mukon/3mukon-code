import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SessionsSection } from '../../sessions/renderer/sessions-section';
import { useSessions } from '../../sessions/renderer/use-sessions';
import { useWorkspaces } from '../../workspaces/renderer/use-workspaces';
import { WorkspacesSection } from '../../workspaces/renderer/workspaces-section';
import type { Bridge } from '../shared/bridge';

// The window shell: a full-height sidebar, which ⌘B shows and hides, beside the main area. The top
// 40px of both form the title bar, which moves the window, shows no title and has no line beneath
// it; the sidebar's divider runs through it and is the shell's only line. The sidebar holds the
// Workspaces section above the Sessions section; the main area stays blank until panels arrive.
export function App({ bridge }: { bridge: Bridge }) {
  const { t } = useTranslation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const workspaces = useWorkspaces(bridge.workspaces);
  const sessions = useSessions(bridge.sessions);

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
            <WorkspacesSection bridge={bridge.workspaces} list={workspaces} />
            <SessionsSection sessions={sessions} folders={workspaces.workspaces} />
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="h-10 shrink-0 select-none [-webkit-app-region:drag]" />
        <main className="min-h-0 flex-1" />
      </div>
    </div>
  );
}
