import type { PanelsBridge } from '../../panels/shared/panels';
import type { SessionsBridge } from '../../sessions/shared/sessions';
import type { WorkspacesBridge } from '../../workspaces/shared/workspaces';

// The preload bridge, the page's only way to the main process: one part per feature module, each the
// interface that module declares in its shared/ folder.
export interface Bridge {
  workspaces: WorkspacesBridge;
  sessions: SessionsBridge;
  panels: PanelsBridge;
}

// The bridge's IPC channels: one per call the main process answers, and one per notification it sends.
export const channels = {
  workspaces: {
    get: 'workspaces:get',
    changed: 'workspaces:changed',
    add: 'workspaces:add',
    addDropped: 'workspaces:add-dropped',
    select: 'workspaces:select',
    showMenu: 'workspaces:show-menu',
    listFolder: 'workspaces:list-folder',
  },
  sessions: {
    list: 'sessions:list',
    changed: 'sessions:changed',
  },
  panels: {
    itemsAt: 'panels:items-at',
  },
} as const;
