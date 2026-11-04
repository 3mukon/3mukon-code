import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FilesBridge } from '../shared/files';
import { FileEditor, nameOf, type EditorHandle, type FoundFormat } from './file-editor';
import { ViewToggle, type FileView } from './rendered-view';

// A panel that shows a file, as whoever lays out the panels shows it: the editor as its body, whether
// it holds unsaved changes, what to ask before it closes, which resolves with whether it may, and for
// a file in a format that renders, the toggle between its rendered view and its raw text, for the
// panel's header.
export interface FilePanel {
  body: ReactNode;
  unsaved: boolean;
  confirmClose: () => Promise<boolean>;
  actions?: ReactNode;
}

export interface FileEditorsOptions {
  // Opens another file in a panel, as a link in a rendered Markdown file asks.
  onOpenFile?: (path: string) => void;
}

export interface FileEditors {
  panel(panelId: string, path: string): FilePanel;
}

interface Shown {
  path: string;
  handle: EditorHandle;
}

// The window's file editors, one per panel that shows a file. A file in a format that renders opens
// rendered, or raw when it does not parse, and each panel keeps its own choice while it is open
// (ADR-0018). The main process watches the files they show and tells them when one changes on disk. Closing a panel with unsaved changes asks whether to
// save them first, and while any editor holds unsaved changes, the page holds back its unload, so
// that the main process asks before the window closes, the app quits or the page loads again.
export function useFileEditors(
  bridge: FilesBridge,
  { onOpenFile }: FileEditorsOptions = {},
): FileEditors {
  const shown = useRef(new Map<string, Shown>());
  // How each panel that shows a file in a format that renders shows it.
  const [views, setViews] = useState<ReadonlyMap<string, FileView>>(() => new Map());
  const [watched, setWatched] = useState<readonly string[]>([]);
  const [unsaved, setUnsaved] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    bridge.watch(watched).catch(report);
  }, [bridge, watched]);

  useEffect(
    () =>
      bridge.onChange((path) => {
        for (const editor of shown.current.values()) {
          if (editor.path === path) editor.handle.reread();
        }
      }),
    [bridge],
  );

  const holdsUnsaved = unsaved.size > 0;
  useEffect(() => {
    if (!holdsUnsaved) return;
    const holdBack = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', holdBack);
    return () => {
      window.removeEventListener('beforeunload', holdBack);
    };
  }, [holdsUnsaved]);

  const setPanelUnsaved = (panelId: string, value: boolean) => {
    setUnsaved((current) => {
      if (current.has(panelId) === value) return current;
      const next = new Set(current);
      if (value) next.add(panelId);
      else next.delete(panelId);
      return next;
    });
  };

  const setView = (panelId: string, view: FileView | null) => {
    setViews((current) => {
      if ((current.get(panelId) ?? null) === view) return current;
      const next = new Map(current);
      if (view === null) next.delete(panelId);
      else next.set(panelId, view);
      return next;
    });
  };
  // A file found in a format opens rendered, or raw when it does not parse; one the panel already
  // shows keeps the panel's choice.
  const found = (panelId: string, format: FoundFormat | null) => {
    setViews((current) => {
      if (format === null) {
        if (!current.has(panelId)) return current;
        const next = new Map(current);
        next.delete(panelId);
        return next;
      }
      if (current.has(panelId)) return current;
      return new Map(current).set(panelId, format.parses ? 'rendered' : 'raw');
    });
  };
  const register = (panelId: string, path: string, handle: EditorHandle | null) => {
    if (handle === null) {
      shown.current.delete(panelId);
      setPanelUnsaved(panelId, false);
      setView(panelId, null);
    } else {
      shown.current.set(panelId, { path, handle });
    }
    const paths = [...new Set([...shown.current.values()].map((editor) => editor.path))].sort();
    setWatched((current) =>
      current.length === paths.length && current.every((each, index) => each === paths[index])
        ? current
        : paths,
    );
  };

  return {
    panel: (panelId, path) => {
      const view = views.get(panelId);
      return {
        body: (
          <FileEditor
            key={path}
            bridge={bridge}
            path={path}
            view={view ?? 'raw'}
            onUnsavedChange={(value) => {
              setPanelUnsaved(panelId, value);
            }}
            onHandle={(handle) => {
              register(panelId, path, handle);
            }}
            onFormat={(format) => {
              found(panelId, format);
            }}
            onOpenFile={onOpenFile}
          />
        ),
        ...(view === undefined
          ? {}
          : {
              actions: (
                <ViewToggle
                  view={view}
                  onChange={(next) => {
                    setView(panelId, next);
                  }}
                />
              ),
            }),
        unsaved: unsaved.has(panelId),
        confirmClose: async () => {
          const editor = shown.current.get(panelId);
          if (editor?.handle.unsaved() !== true) return true;
          const answer = await bridge.confirmClose(nameOf(path));
          if (answer === 'save') return editor.handle.save();
          return answer === 'discard';
        },
      };
    },
  };
}

function report(error: unknown): void {
  console.error('The open files could not be watched:', error);
}
