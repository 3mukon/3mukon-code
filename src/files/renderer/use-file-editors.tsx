import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FilesBridge } from '../shared/files';
import { FileEditor, nameOf, type EditorHandle } from './file-editor';

// A panel that shows a file, as whoever lays out the panels shows it: the editor as its body, whether
// it holds unsaved changes, and what to ask before it closes, which resolves with whether it may.
export interface FilePanel {
  body: ReactNode;
  unsaved: boolean;
  confirmClose: () => Promise<boolean>;
}

export interface FileEditors {
  panel(panelId: string, path: string): FilePanel;
}

interface Shown {
  path: string;
  handle: EditorHandle;
}

// The window's file editors, one per panel that shows a file. The main process watches the files they
// show and tells them when one changes on disk. Closing a panel with unsaved changes asks whether to
// save them first, and while any editor holds unsaved changes, the page holds back its unload, so
// that the main process asks before the window closes, the app quits or the page loads again.
export function useFileEditors(bridge: FilesBridge): FileEditors {
  const shown = useRef(new Map<string, Shown>());
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

  const register = (panelId: string, path: string, handle: EditorHandle | null) => {
    if (handle === null) {
      shown.current.delete(panelId);
      setPanelUnsaved(panelId, false);
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
    panel: (panelId, path) => ({
      body: (
        <FileEditor
          key={path}
          bridge={bridge}
          path={path}
          onUnsavedChange={(value) => {
            setPanelUnsaved(panelId, value);
          }}
          onHandle={(handle) => {
            register(panelId, path, handle);
          }}
        />
      ),
      unsaved: unsaved.has(panelId),
      confirmClose: async () => {
        const editor = shown.current.get(panelId);
        if (editor?.handle.unsaved() !== true) return true;
        const answer = await bridge.confirmClose(nameOf(path));
        if (answer === 'save') return editor.handle.save();
        return answer === 'discard';
      },
    }),
  };
}

function report(error: unknown): void {
  console.error('The open files could not be watched:', error);
}
