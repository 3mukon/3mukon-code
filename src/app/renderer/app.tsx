import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from '../../ui/renderer/icons';

// The window shell: a full-height sidebar, which ⌘B shows and hides, beside the main area. The top
// 40px of both form the title bar, which moves the window, shows no title and has no line beneath
// it; the sidebar's divider runs through it and is the shell's only line. The session list and the
// panes join the shell with their modules; until then the main area is blank.
export function App() {
  const { t } = useTranslation();
  const sessionsHeading = useId();
  const [sidebarOpen, setSidebarOpen] = useState(true);

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
            <div className="truncate px-2 leading-5 font-bold">3mukon-code</div>
            <section aria-labelledby={sessionsHeading}>
              <div className="flex items-center gap-1 px-2">
                <h2 id={sessionsHeading} className="text-[11px] text-faint">
                  {t('sidebar.sessions')}
                </h2>
                {/* New session, a plus icon whose name VoiceOver reads and the tooltip shows; the
                    negative margin keeps the heading's row height. Starting sessions arrives with
                    the sessions module. */}
                <button
                  type="button"
                  disabled
                  aria-label={t('sidebar.newSession')}
                  title={t('sidebar.newSession')}
                  className="-my-0.5 grid size-5 place-items-center rounded-md text-faint"
                >
                  <Plus className="size-4" />
                </button>
              </div>
            </section>
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
