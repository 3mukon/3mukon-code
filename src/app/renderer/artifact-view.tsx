import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTable } from '../../files/renderer/data-table';
import {
  artifactWithinLimits,
  type Artifact,
  type PresentationBridge,
  type TableCell,
} from '../../panels/shared/presentation';
import { Markdown } from '../../ui/renderer/markdown';

// An artifact an agent presents, as the window has it: being read from main, read, gone from main,
// or outside the artifacts' limits, which the window checks again as it draws one.
export type ArtifactState =
  | { status: 'loading' }
  | { status: 'ready'; artifact: Artifact }
  | { status: 'gone' }
  | { status: 'invalid' };

// The artifacts the panels show, by their ids, each read once from main as a panel first shows it.
// Main hands a new id to every artifact an agent makes, so one id always names the same artifact. One
// that no panel shows any longer is forgotten as the next one arrives.
export function useArtifacts(
  bridge: PresentationBridge | undefined,
  shown: readonly string[],
): ReadonlyMap<string, ArtifactState> {
  const [states, setStates] = useState<ReadonlyMap<string, ArtifactState>>(new Map());
  const asked = useRef(new Set<string>());
  const key = [...new Set(shown)].sort().join('\n');
  useEffect(() => {
    const ids = new Set(key === '' ? [] : key.split('\n'));
    for (const id of asked.current) if (!ids.has(id)) asked.current.delete(id);
    if (bridge === undefined) return;
    for (const id of ids) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      const settle = (state: ArtifactState) => {
        if (!asked.current.has(id)) return;
        setStates((before) =>
          new Map([...before].filter(([kept]) => asked.current.has(kept))).set(id, state),
        );
      };
      bridge.artifact(id).then(
        (artifact) => {
          if (artifact === null) settle({ status: 'gone' });
          else
            settle(
              artifactWithinLimits(artifact)
                ? { status: 'ready', artifact }
                : { status: 'invalid' },
            );
        },
        (error: unknown) => {
          console.error('The presented result could not be read:', error);
          settle({ status: 'gone' });
        },
      );
    }
  }, [bridge, key]);
  return states;
}

// A presented artifact's panel body: Markdown as a file's rendered view shows it, an image fitted to
// the panel, or a table as the files' table shows a CSV file, its columns the header. What is still
// being read, gone or outside the limits says so.
export function ArtifactView({ state }: { state: ArtifactState }) {
  const { t } = useTranslation();
  switch (state.status) {
    case 'loading':
      return <Notice>{t('panels.resultLoading')}</Notice>;
    case 'gone':
      return <Notice>{t('panels.resultGone')}</Notice>;
    case 'invalid':
      return <Notice>{t('panels.resultInvalid')}</Notice>;
    case 'ready':
      return <ArtifactContent artifact={state.artifact} />;
  }
}

function ArtifactContent({ artifact }: { artifact: Artifact }) {
  switch (artifact.format) {
    case 'markdown':
      return (
        <div className="h-full min-h-0 overflow-auto px-5 py-4">
          <article className="max-w-[46rem] text-[13px]/[1.65] text-ink select-text">
            <Markdown text={artifact.text} document />
          </article>
        </div>
      );
    case 'image':
      return (
        <div className="grid h-full min-h-0 place-items-center p-4">
          <img
            src={`data:${artifact.mediaType};base64,${artifact.data}`}
            alt={artifact.title}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    case 'table':
      return (
        <div className="h-full min-h-0 overflow-auto px-5 py-4">
          <DataTable rows={[artifact.columns, ...artifact.rows.map((row) => row.map(cellText))]} />
        </div>
      );
  }
}

// What a table's cell shows: its text, number or truth value, or nothing.
function cellText(cell: TableCell): string {
  return cell === null ? '' : String(cell);
}

// What a panel says in place of what it cannot show.
export function Notice({ children }: { children: string }) {
  return <div className="p-5 text-[12.5px] text-muted">{children}</div>;
}
