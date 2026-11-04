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
import { formatOf, type FileFormat } from './formats';
import { parse, RenderedView, type FileView } from './rendered-view';
import { TextEditor } from './text-editor';

// How long the rendered view waits after the text last changed before it renders it anew.
const RENDER_WAIT_MS = 150;

// A file's format, and whether its text parses in it as the file opens.
export interface FoundFormat {
  format: FileFormat;
  parses: boolean;
}

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
  // Whether the panel shows the file rendered or raw; rendered applies only to a file in a format
  // that renders.
  view: FileView;
  onUnsavedChange: (unsaved: boolean) => void;
  // The editor's handle once it shows the file, and null once it no longer does.
  onHandle: (handle: EditorHandle | null) => void;
  // The file's format once its text has opened, or null for a file that renders in none.
  onFormat: (found: FoundFormat | null) => void;
  // Opens another file in a panel, as a link in a rendered Markdown file asks.
  onOpenFile?: ((path: string) => void) | undefined;
}

const noticeKeys = {
  binary: 'files.notice.binary',
  'too-large': 'files.notice.tooLarge',
  missing: 'files.notice.missing',
  unreadable: 'files.notice.unreadable',
  outside: 'files.notice.outside',
} as const satisfies Record<FileNotice, string>;

// A file's panel body: the file in the editor, or a notice for a file it cannot edit, and, for a file in
// a format that renders (ADR-0018), its rendered view in the editor's place while the panel shows it
// rendered, the editor staying with its unsaved changes; the view follows the editor's text. ⌘S saves
// it from anywhere in the panel. When the file changes on disk, an editor without unsaved changes shows
// the new text; one with unsaved changes says so above its text and offers to reload it or keep
// editing, after which saving overwrites the file. A removed file says so too, and saving writes it
// again; a save that fails says why.
export function FileEditor({
  bridge,
  path,
  view,
  onUnsavedChange,
  onHandle,
  onFormat,
  onOpenFile,
}: FileEditorProps) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  // The text as the editor holds it, which the rendered view shows, and the file's format.
  const [text, setText] = useState('');
  const [format, setFormat] = useState<FileFormat | null>(null);
  const [bar, setBar] = useState<Bar | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<TextEditor | null>(null);
  const handle = useRef<EditorHandle | null>(null);
  const name = nameOf(path);

  const reportFormat = useEffectEvent((found: FoundFormat | null) => {
    onFormat(found);
  });

  // The file as it opens, with its format: by the file's name, or, without an extension, by how its
  // text begins, which counts only if it parses.
  useEffect(() => {
    let live = true;
    bridge.open(path).then(
      (file) => {
        if (!live) return;
        setOpened(file);
        if (file.kind !== 'text') return;
        setText(file.text);
        const found = formatOf(path, file.text);
        const parses = found !== null && parse(found.format, file.text).kind !== 'failed';
        if (found === null || (found.sniffed && !parses)) {
          setFormat(null);
          reportFormat(null);
        } else {
          setFormat(found.format);
          reportFormat({ format: found.format, parses });
        }
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
    let wait: ReturnType<typeof setTimeout> | undefined;
    const shown = new TextEditor(host.current, opened, {
      name,
      label: name,
      phrases: phrases(),
      onUnsavedChange: (unsaved) => {
        reportUnsaved(unsaved);
      },
      onTextChange: () => {
        clearTimeout(wait);
        wait = setTimeout(() => {
          setText(shown.contents().text);
        }, RENDER_WAIT_MS);
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
      clearTimeout(wait);
      shown.destroy();
      editor.current = null;
      handle.current = null;
      handOver(null);
    };
  }, [bridge, path, name, opened]);

  const rendered = view === 'rendered' && format !== null;
  // Back in the raw view, the editor takes the keyboard.
  useEffect(() => {
    if (!rendered) editor.current?.focus();
  }, [rendered]);

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
      <div ref={host} className={`relative min-h-0 min-w-0 ${rendered ? 'hidden' : ''}`} />
      {rendered && (
        <RenderedView
          bridge={bridge}
          path={path}
          format={format}
          text={text}
          onOpenFile={onOpenFile}
        />
      )}
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
