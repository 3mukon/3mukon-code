import type { ApprovalsBridge } from '../../approvals/shared/approvals';
import type { FilesBridge } from '../../files/shared/files';
import type { PanelsBridge } from '../../panels/shared/panels';
import type { SessionsBridge } from '../../sessions/shared/sessions';
import type { WorkspacesBridge } from '../../workspaces/shared/workspaces';

// The preload bridge, the page's only way to the main process: one part per feature module, each the
// interface that module declares in its shared/ folder.
export interface Bridge {
  workspaces: WorkspacesBridge;
  sessions: SessionsBridge;
  panels: PanelsBridge;
  files: FilesBridge;
  approvals: ApprovalsBridge;
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
    providers: 'sessions:providers',
    dayFolder: 'sessions:day-folder',
    gateways: 'sessions:gateways',
    models: 'sessions:models',
    choices: 'sessions:choices',
    rememberChoice: 'sessions:remember-choice',
    confirmYolo: 'sessions:confirm-yolo',
    copyText: 'sessions:copy-text',
    copyImage: 'sessions:copy-image',
    saveImage: 'sessions:save-image',
    imageMenu: 'sessions:image-menu',
    start: 'sessions:start',
    send: 'sessions:send',
    interrupt: 'sessions:interrupt',
    setMode: 'sessions:set-mode',
    setGateway: 'sessions:set-gateway',
    setModel: 'sessions:set-model',
    setEffort: 'sessions:set-effort',
    setSandbox: 'sessions:set-sandbox',
    snapshot: 'sessions:snapshot',
    event: 'sessions:event',
  },
  panels: {
    itemsAt: 'panels:items-at',
  },
  files: {
    open: 'files:open',
    save: 'files:save',
    watch: 'files:watch',
    changed: 'files:changed',
    confirmClose: 'files:confirm-close',
  },
  approvals: {
    answerApproval: 'approvals:answer-approval',
    answerQuestion: 'approvals:answer-question',
  },
} as const;
