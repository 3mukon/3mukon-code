import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
          <div className="flex min-h-0 flex-1 flex-col gap-[18px] px-2.5 py-3.5">
            <div className="truncate px-2 py-1 font-medium">3mukon-code</div>
            <section aria-labelledby={sessionsHeading}>
              <h2 id={sessionsHeading} className="mb-1 px-2 text-[11px] text-faint">
                {t('sidebar.sessions')}
              </h2>
              <p className="px-2 text-muted">{t('sidebar.noSessions')}</p>
            </section>
            <div className="flex-1" />
            {/* Starting sessions arrives with the sessions module. */}
            <button type="button" disabled className="rounded-md px-2 py-1.5 text-left text-faint">
              <span aria-hidden="true">+ </span>
              {t('sidebar.newSession')}
            </button>
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
