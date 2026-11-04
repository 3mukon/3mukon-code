import type { ApprovalsBridge } from '../../approvals/shared/approvals';
import type { FilesBridge } from '../../files/shared/files';
import type { PanelsBridge } from '../../panels/shared/panels';
import type { SessionsBridge } from '../../sessions/shared/sessions';
import type { SettingsBridge } from '../../settings/shared/settings';
import type { Prompt } from '../../ui/shared/prompts';
import type { WorkspacesBridge } from '../../workspaces/shared/workspaces';

// The preload bridge, the page's only way to the main process: one part per feature module, each the
// interface that module declares in its shared/ folder, and the prompts, this module's own.
export interface Bridge {
  workspaces: WorkspacesBridge;
  sessions: SessionsBridge;
  panels: PanelsBridge;
  files: FilesBridge;
  approvals: ApprovalsBridge;
  settings: SettingsBridge;
  prompts: PromptsBridge;
}

// The menus and questions the main process asks the user, which the page draws in the app's own look.
export interface PromptsBridge {
  // Calls the listener with each prompt the page is to draw, by its id, and returns a function that
  // stops it.
  onPrompt(listener: (id: number, prompt: Prompt) => void): () => void;
  // Answers the prompt: a menu's chosen item's id, or null, or a question's answer's id.
  answer(id: number, answer: string | null): Promise<void>;
}

// The command-line switch by which a window's page gets the settings as the window opens, before it
// can ask for them, with the settings as URI-encoded JSON.
export const settingsSwitch = '--app-settings=';

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
    archived: 'sessions:archived',
    resume: 'sessions:resume',
    showMenu: 'sessions:show-menu',
    act: 'sessions:act',
    search: 'sessions:search',
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
    preload: 'sessions:preload',
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
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    changed: 'settings:changed',
  },
  prompts: {
    show: 'prompts:show',
    answer: 'prompts:answer',
  },
} as const;
