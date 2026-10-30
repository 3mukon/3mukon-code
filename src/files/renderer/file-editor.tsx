import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MAX_EDITABLE_BYTES,
  type FileNotice,
  type FilesBridge,
  type OpenedFile,
  type SaveResult,
} from '../shared/files';
import { PHRASES } from './editor-setup';
import { TextEditor } from './text-editor';

// What others may do with an editor showing a file.
export interface EditorHandle {
  unsaved(): boolean;
  // Saves the file; resolves with whether it was saved.
  save(): Promise<boolean>;
  // The file changed on disk, so the editor reads it again.
  reread(): void;
}

// What the bar above the editor says: the file changed on disk while unsaved changes stood against
// it, with the text it now holds; it was removed; or saving it failed.
type Bar =
  | { kind: 'changed'; text: string }
  | { kind: 'deleted' }
  | { kind: 'failed'; reason: Extract<SaveResult, { saved: false }>['reason'] };

interface FileEditorProps {
  bridge: FilesBridge;
  path: string;
  onUnsavedChange: (unsaved: boolean) => void;
  // The editor's handle once it shows the file, and null once it no longer does.
  onHandle: (handle: EditorHandle | null) => void;
}

const noticeKeys = {
  binary: 'files.notice.binary',
  'too-large': 'files.notice.tooLarge',
  missing: 'files.notice.missing',
  unreadable: 'files.notice.unreadable',
  outside: 'files.notice.outside',
} as const satisfies Record<FileNotice, string>;

// A file's panel body: the file in the editor, or a notice for a file it cannot edit. ⌘S saves it
// from anywhere in the panel. When the file changes on disk, an editor without unsaved changes shows
// the new text; one with unsaved changes says so above its text and offers to reload it or keep
// editing, after which saving overwrites the file. A removed file says so too, and saving writes it
// again; a save that fails says why.
export function FileEditor({ bridge, path, onUnsavedChange, onHandle }: FileEditorProps) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  const [bar, setBar] = useState<Bar | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<TextEditor | null>(null);
  const handle = useRef<EditorHandle | null>(null);
  const name = nameOf(path);

  useEffect(() => {
    let live = true;
    bridge.open(path).then(
      (file) => {
        if (live) setOpened(file);
      },
      () => {
        if (live) setOpened({ kind: 'notice', notice: 'unreadable' });
      },
    );
    return () => {
      live = false;
    };
  }, [bridge, path]);

  const reportUnsaved = useEffectEvent((unsaved: boolean) => {
    onUnsavedChange(unsaved);
  });
  const handOver = useEffectEvent((shown: EditorHandle | null) => {
    onHandle(shown);
  });
  const phrases = useEffectEvent(() =>
    Object.fromEntries(
      (Object.keys(PHRASES) as (keyof typeof PHRASES)[]).map((phrase) => [
        phrase,
        t(`files.editor.${PHRASES[phrase]}`),
      ]),
    ),
  );

  useEffect(() => {
    if (opened?.kind !== 'text' || host.current === null) return;
    const shown = new TextEditor(host.current, opened, {
      name,
      label: name,
      phrases: phrases(),
      onUnsavedChange: (unsaved) => {
        reportUnsaved(unsaved);
      },
    });
    editor.current = shown;
    const save = async () => {
      const { text, doc } = shown.contents();
      const result = await bridge.save(path, text).catch((): SaveResult => ({
        saved: false,
        reason: 'failed',
      }));
      if (!result.saved) {
        setBar({ kind: 'failed', reason: result.reason });
        return false;
      }
      shown.saved(doc);
      setBar(null);
      return true;
    };
    const reread = async () => {
      const file = await bridge.open(path).catch(() => null);
      if (file === null || editor.current !== shown) return;
      if (file.kind === 'notice') {
        if (file.notice === 'missing') setBar({ kind: 'deleted' });
        return;
      }
      if (shown.diskChanged(file.text) === 'conflict') setBar({ kind: 'changed', text: file.text });
      else setBar((current) => (current?.kind === 'failed' ? current : null));
    };
    handle.current = {
      unsaved: () => shown.unsaved,
      save,
      reread: () => {
        void reread();
      },
    };
    handOver(handle.current);
    return () => {
      shown.destroy();
      editor.current = null;
      handle.current = null;
      handOver(null);
    };
  }, [bridge, path, name, opened]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const onlyCommand = event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
    if (!onlyCommand || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    void handle.current?.save();
  };

  if (opened === null) return <div aria-busy="true" />;
  if (opened.kind === 'notice') {
    return (
      <div className="grid place-items-center p-6">
        <p className="max-w-sm text-center text-[12.5px] text-muted">
          {t(noticeKeys[opened.notice], {
            name,
            size: `${String(MAX_EDITABLE_BYTES / 1024 / 1024)} MB`,
          })}
        </p>
      </div>
    );
  }
  return (
    <div onKeyDown={onKeyDown} className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
      <div role="status">
        {bar !== null && (
          <div className="flex min-w-0 items-center gap-2 border-y border-dashed border-line bg-well px-5 py-1.5 text-[12px] text-ink">
            <span className="min-w-0 flex-1">{t(barKey(bar))}</span>
            {bar.kind === 'changed' ? (
              <>
                <BarButton
                  label={t('files.changed.reload')}
                  onClick={() => {
                    editor.current?.reload(bar.text);
                    setBar(null);
                  }}
                />
                <BarButton
                  label={t('files.changed.keep')}
                  onClick={() => {
                    editor.current?.keep(bar.text);
                    setBar(null);
                    editor.current?.focus();
                  }}
                />
              </>
            ) : (
              <BarButton
                label={t('files.bar.dismiss')}
                onClick={() => {
                  setBar(null);
                  editor.current?.focus();
                }}
              />
            )}
          </div>
        )}
      </div>
      <div ref={host} className="relative min-h-0 min-w-0" />
    </div>
  );
}

function BarButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-md px-2 text-[11px] text-muted hover:bg-hover hover:text-ink"
    >
      {label}
    </button>
  );
}

function barKey(bar: Bar) {
  if (bar.kind === 'changed') return 'files.changed.message' as const;
  if (bar.kind === 'deleted') return 'files.deleted' as const;
  return `files.failed.${bar.reason}` as const;
}

// The last name in a path.
export function nameOf(path: string): string {
  return path.split('/').at(-1) ?? path;
}
