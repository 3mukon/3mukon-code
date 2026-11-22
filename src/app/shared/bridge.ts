import type { AccountsBridge } from '../../accounts/shared/accounts';
import type { ApprovalsBridge } from '../../approvals/shared/approvals';
import type { BrowserBridge } from '../../browser/shared/view';
import type { ComputerBridge } from '../../computer/shared/computer';
import type { FilesBridge } from '../../files/shared/files';
import type { PanelsBridge } from '../../panels/shared/panels';
import type { PresentationBridge } from '../../panels/shared/presentation';
import type { SessionsBridge } from '../../sessions/shared/sessions';
import type { SettingsBridge } from '../../settings/shared/settings';
import type { TerminalBridge } from '../../terminal/shared/terminal';
import type { AutomationBridge, UserSetupBridge } from '../../toolset/shared/automation';
import type { Prompt } from '../../ui/shared/prompts';
import type { WorkspacesBridge } from '../../workspaces/shared/workspaces';

// The preload bridge, the page's only way to the main process: one part per feature module, each the
// interface that module declares in its shared/ folder, and the prompts, this module's own.
export interface Bridge {
  workspaces: WorkspacesBridge;
  sessions: SessionsBridge;
  panels: PanelsBridge;
  presentations: PresentationBridge;
  automation: AutomationBridge;
  browser: BrowserBridge;
  computer: ComputerBridge;
  // What the settings and the sessions' setup notices show of browser and computer use, with the
  // steps the user's click takes there.
  setup: UserSetupBridge;
  files: FilesBridge;
  approvals: ApprovalsBridge;
  settings: SettingsBridge;
  terminal: TerminalBridge;
  accounts: AccountsBridge;
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
  browser: {
    tabRef: 'browser:tab-ref',
    snapshot: 'browser:snapshot',
    subscribe: 'browser:subscribe',
    unsubscribe: 'browser:unsubscribe',
    state: 'browser:state',
    command: 'browser:command',
    bind: 'browser:bind',
    place: 'browser:place',
    release: 'browser:release',
    focus: 'browser:focus',
    fileDrag: 'browser:file-drag',
  },
  computer: {
    preview: 'computer:preview',
    command: 'computer:command',
  },
  automation: {
    snapshot: 'automation:snapshot',
    subscribe: 'automation:subscribe',
    unsubscribe: 'automation:unsubscribe',
    event: 'automation:event',
    callRecord: 'automation:call-record',
    callFrames: 'automation:call-frames',
    icon: 'automation:icon',
    capabilities: 'automation:capabilities',
    answer: 'automation:answer',
    stop: 'automation:stop',
    endOperation: 'automation:end-operation',
    endGrant: 'automation:end-grant',
  },
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
  presentations: {
    message: 'presentations:message',
    report: 'presentations:report',
    artifact: 'presentations:artifact',
  },
  files: {
    open: 'files:open',
    save: 'files:save',
    watch: 'files:watch',
    changed: 'files:changed',
    confirmClose: 'files:confirm-close',
    image: 'files:image',
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
  setup: {
    snapshot: 'setup:snapshot',
    act: 'setup:act',
    changed: 'setup:changed',
  },
  terminal: {
    open: 'terminal:open',
    write: 'terminal:write',
    resize: 'terminal:resize',
    output: 'terminal:output',
    exit: 'terminal:exit',
    confirmClose: 'terminal:confirm-close',
    close: 'terminal:close',
    openLink: 'terminal:open-link',
  },
  accounts: {
    list: 'accounts:list',
    changed: 'accounts:changed',
    setShown: 'accounts:set-shown',
    signIn: 'accounts:sign-in',
    reset: 'accounts:reset',
  },
  prompts: {
    show: 'prompts:show',
    answer: 'prompts:answer',
  },
} as const;
