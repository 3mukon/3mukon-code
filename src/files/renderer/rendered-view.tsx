import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Markdown } from '../../ui/renderer/markdown';
import type { FilesBridge } from '../shared/files';
import { DataTable } from './data-table';
import { DataTree } from './data-tree';
import { parseData, parseTable, parseXml, type FileFormat, type ParseFailure } from './formats';

// What the panel shows of a file: its rendered view, or its raw text in the editor.
export type FileView = 'rendered' | 'raw';

interface RenderedViewProps {
  bridge: Pick<FilesBridge, 'image'>;
  // The file's absolute path, which its Markdown's links and images go from.
  path: string;
  format: FileFormat;
  // The file's text as the editor holds it now, unsaved edits included.
  text: string;
  // Opens another file in a panel, as a link in Markdown asks.
  onOpenFile?: ((path: string) => void) | undefined;
}

// A file rendered in its format (ADR-0018): Markdown as the activity's messages render, at a
// document's size, its local images read as data and its links to files opened in panels; JSON, XML,
// YAML and TOML as a folding tree; CSV and TSV as a table; SVG as the picture it draws, which runs
// none of its scripts. A text that does not parse says where it fails. It loads nothing from the
// network and cannot be edited; its text can be selected and copied.
export function RenderedView({ bridge, path, format, text, onOpenFile }: RenderedViewProps) {
  const { t } = useTranslation();
  const folder = path.slice(0, path.lastIndexOf('/')) || '/';
  const parsed = useMemo(() => parse(format, text), [format, text]);
  const image = useMemo(
    () => (src: string, alt: string) => (
      <LocalImage bridge={bridge} folder={folder} src={src} alt={alt} />
    ),
    [bridge, folder],
  );
  const onLink = useMemo(
    () =>
      onOpenFile === undefined
        ? undefined
        : (href: string) => {
            const target = resolve(folder, href);
            if (target !== null) onOpenFile(target);
          },
    [folder, onOpenFile],
  );
  if (parsed.kind === 'failed') {
    return (
      <div className="p-5 text-[12.5px] text-muted">
        {t('files.rendered.failed', {
          format: t(`files.formats.${format}`),
          line: parsed.failure.line,
          column: parsed.failure.column,
        })}
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 overflow-auto px-5 py-4">
      {parsed.kind === 'markdown' && (
        <article className="max-w-[46rem] text-[13px]/[1.65] text-ink select-text">
          <Markdown
            text={text}
            image={image}
            document
            {...(onLink === undefined ? {} : { onLink })}
          />
        </article>
      )}
      {parsed.kind === 'tree' && <DataTree root={parsed.root} />}
      {parsed.kind === 'table' && <DataTable rows={parsed.rows} />}
      {parsed.kind === 'svg' && (
        <div className="grid h-full min-h-0 place-items-center">
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`}
            alt={path.slice(path.lastIndexOf('/') + 1)}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      )}
    </div>
  );
}

type Rendering =
  | { kind: 'markdown' }
  | { kind: 'tree'; root: Parameters<typeof DataTree>[0]['root'] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'svg' }
  | { kind: 'failed'; failure: ParseFailure };

// What a text renders as in its format, or where it fails to parse.
export function parse(format: FileFormat, text: string): Rendering {
  switch (format) {
    case 'markdown':
      return { kind: 'markdown' };
    case 'csv':
    case 'tsv': {
      const table = parseTable(text, format === 'csv' ? ',' : '\t');
      return table.ok
        ? { kind: 'table', rows: table.value }
        : { kind: 'failed', failure: table.failure };
    }
    case 'svg': {
      const svg = parseXml(text, 'image/svg+xml');
      return svg.ok ? { kind: 'svg' } : { kind: 'failed', failure: svg.failure };
    }
    default: {
      const data = parseData(format, text);
      return data.ok
        ? { kind: 'tree', root: data.value }
        : { kind: 'failed', failure: data.failure };
    }
  }
}

// An image of a Markdown file: one in a data URL as it is; one beside the file read through the
// bridge as data, where the files module may read it; one on the web, or one that cannot be read, as
// a link to it, never fetched.
function LocalImage({
  bridge,
  folder,
  src,
  alt,
}: {
  bridge: Pick<FilesBridge, 'image'>;
  folder: string;
  src: string;
  alt: string;
}) {
  const local =
    src.startsWith('data:') || /^[a-z][\w+.-]*:/i.test(src) ? null : resolve(folder, src);
  const [data, setData] = useState<string | null>(src.startsWith('data:image/') ? src : null);
  useEffect(() => {
    if (local === null) return;
    let live = true;
    bridge.image(local).then(
      (image) => {
        if (live && image !== null) setData(`data:${image.mediaType};base64,${image.data}`);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bridge, local]);
  if (data !== null) return <img src={data} alt={alt} className="my-2 inline-block max-w-full" />;
  return (
    <a href={src} className="text-accent underline underline-offset-2">
      {alt === '' ? src : alt}
    </a>
  );
}

// A link's or an image's path as an absolute path from the file's folder, its query and fragment left
// out; null for a link elsewhere, such as on the web, or within the text.
export function resolve(folder: string, href: string): string | null {
  if (href.startsWith('#') || /^[a-z][\w+.-]*:/i.test(href)) return null;
  let path: string;
  try {
    path = decodeURI(href.replace(/[?#].*$/, ''));
  } catch {
    return null;
  }
  if (path === '') return null;
  const parts = (path.startsWith('/') ? path : `${folder}/${path}`).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return `/${resolved.join('/')}`;
}

// The toggle at the right of a file's panel header between its rendered view and its raw text.
export function ViewToggle({
  view,
  onChange,
}: {
  view: FileView;
  onChange: (view: FileView) => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t('files.view.label')} className="flex items-center gap-0.5">
      {(['rendered', 'raw'] as const).map((each) => (
        <button
          key={each}
          type="button"
          aria-pressed={view === each}
          onClick={() => {
            onChange(each);
          }}
          className={`rounded-md px-1.5 text-[11px] leading-5 font-normal ${view === each ? 'bg-selected text-ink' : 'text-faint hover:bg-hover hover:text-ink'}`}
        >
          {t(`files.view.${each}`)}
        </button>
      ))}
    </div>
  );
}
