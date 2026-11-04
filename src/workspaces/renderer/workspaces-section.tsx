import { useId, useState, type DragEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from '../../ui/renderer/icons';
import type { WorkspaceList, WorkspacesBridge } from '../shared/workspaces';
import { WorkspaceTree, type TreeItem } from './workspace-tree';

interface WorkspacesSectionProps {
  bridge: WorkspacesBridge;
  list: WorkspaceList;
  // A press on a row of the tree, which whoever composes the section may follow to drag the row
  // elsewhere.
  onPressItem?: (item: TreeItem, press: PointerEvent<HTMLElement>) => void;
  // Opens a row of the tree elsewhere, as dropping it would.
  onOpenItem?: (item: TreeItem) => void;
  // Opens a terminal in a workspace's folder, as its menu asks.
  onOpenInTerminal?: (folder: string) => void;
}

// The sidebar's Workspaces section: its heading with Add workspace just after it, and the workspaces'
// tree. Folders dropped from the Finder anywhere on the section are added too. Without workspaces it
// shows the heading alone.
export function WorkspacesSection({
  bridge,
  list,
  onPressItem,
  onOpenItem,
  onOpenInTerminal,
}: WorkspacesSectionProps) {
  const { t } = useTranslation();
  const heading = useId();
  const [dropping, setDropping] = useState(false);

  // Items from the Finder carry files; anything else dragged over the section is left alone.
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');

  return (
    <section
      aria-labelledby={heading}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(event) => {
        // Moving between the section's own rows is no leaving.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDropping(false);
        bridge.addDropped([...event.dataTransfer.files]).catch(report);
      }}
      className={`flex max-h-[55%] min-h-0 shrink-0 flex-col gap-1 rounded-md ${dropping ? 'bg-hover outline-2 outline-accent' : ''}`}
    >
      <div className="flex items-center gap-1 px-2">
        <h2 id={heading} className="text-[11px] text-faint">
          {t('workspaces.heading')}
        </h2>
        {/* Add workspace, a plus icon whose name VoiceOver reads and the tooltip shows; the negative
            margin keeps the heading's row height. */}
        <button
          type="button"
          aria-label={t('workspaces.add')}
          title={t('workspaces.add')}
          onClick={() => {
            bridge.add().catch(report);
          }}
          className="-my-0.5 grid size-5 place-items-center rounded-md text-faint hover:bg-hover hover:text-ink"
        >
          <Plus className="size-4" />
        </button>
      </div>
      {list.workspaces.length > 0 && (
        <WorkspaceTree
          bridge={bridge}
          list={list}
          labelledBy={heading}
          onPressItem={onPressItem}
          onOpenItem={onOpenItem}
          onOpenInTerminal={onOpenInTerminal}
        />
      )}
    </section>
  );
}

function report(error: unknown): void {
  console.error('The workspace could not be added:', error);
}
