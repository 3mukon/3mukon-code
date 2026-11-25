import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { AccountsButton, AccountsPanel } from '../../accounts/renderer/accounts-panel';
import { SignInPrompt, UsageNotice } from '../../accounts/renderer/session-notes';
import { useAccounts } from '../../accounts/renderer/use-accounts';
import { mostUsed } from '../../accounts/shared/accounts';
import {
  AnsweredHostApproval,
  HostApprovalBlock,
  type GrantStanding,
} from '../../approvals/renderer/host-approval';
import { Request } from '../../approvals/renderer/requests';
import { WaitingButton } from '../../approvals/renderer/waiting-button';
import { nextWaiting } from '../../approvals/shared/waiting';
import { useFileEditors } from '../../files/renderer/use-file-editors';
import {
  contentOf,
  folderOf,
  panelsOf,
  sameContent,
  type Panel,
} from '../../panels/renderer/layout';
import { PanelArea, type PanelAreaHandle, type PanelView } from '../../panels/renderer/panel-area';
import { PresentationEntry } from '../../panels/renderer/presentation-entry';
import { usePanels } from '../../panels/renderer/use-panels';
import type { PanelContent } from '../../panels/shared/panels';
import type { UsedContent } from '../../panels/shared/presentation';
import type {
  AutomationLiveState,
  GrantEndRecord,
  HostApproval,
  SetupRequirement,
  SetupSnapshot,
  TargetSummary,
} from '../../sessions/shared/automation';
import type { SetupAction } from '../../toolset/shared/automation';
import type { MessageImage, ProviderId } from '../../sessions/shared/events';
import type { SessionAction, SessionSummary } from '../../sessions/shared/sessions';
import { BrowserSetupNotice, type BrowserSetupSteps } from '../../browser/renderer/browser-notice';
import { BrowserPageView } from '../../browser/renderer/browser-page-view';
import { BrowserPanel, NO_USE, type TabUse } from '../../browser/renderer/browser-panel';
import { BrowserUseSetting } from '../../browser/renderer/browser-use';
import { WrongChromeFolder } from '../../browser/renderer/chrome-state';
import { useBrowserTabs } from '../../browser/renderer/use-browser-tabs';
import type { BrowserTabRef } from '../../browser/shared/browser';
import {
  ComputerPreviewView,
  NO_APPLICATION_USE,
  type ApplicationUse,
} from '../../computer/renderer/computer-preview';
import {
  ComputerSetupNotice,
  ComputerUseSetting,
  type ComputerSteps,
} from '../../computer/renderer/computer-use';
import { ArchivedButton, ArchivedPanel } from '../../sessions/renderer/archived-panel';
import { AutomationCall } from '../../sessions/renderer/automation-call';
import { deliveryOn, sharingTag, sharingWords } from '../../sessions/renderer/automation-labels';
import { GrantsLine } from '../../sessions/renderer/automation-grants';
import { AutomationLine } from '../../sessions/renderer/automation-line';
import { SessionPage, type AccountViews } from '../../sessions/renderer/session-page';
import { SessionsSection } from '../../sessions/renderer/sessions-section';
import { statusDots, type RenderToolCall } from '../../sessions/renderer/timeline';
import { preloadOffers } from '../../sessions/renderer/use-offers';
import { useSessions } from '../../sessions/renderer/use-sessions';
import { SettingsPanel } from '../../settings/renderer/settings-panel';
import { useSettings } from '../../settings/renderer/use-settings';
import { TerminalPanel } from '../../terminal/renderer/terminal-panel';
import { TerminalViews } from '../../terminal/renderer/terminal-views';
import { Gear, PanelLeft } from '../../ui/renderer/icons';
import { WindowButtonsHole } from '../../ui/renderer/pane';
import { Tag } from '../../ui/renderer/tag';
import { TooltipHost } from '../../ui/renderer/tooltip';
import { useWorkspaces } from '../../workspaces/renderer/use-workspaces';
import type { TreeItem } from '../../workspaces/renderer/workspace-tree';
import { WorkspacesSection } from '../../workspaces/renderer/workspaces-section';
import type { Bridge } from '../shared/bridge';
import { ArtifactView, Notice, useArtifacts } from './artifact-view';
import { useAutomation } from './use-automation';
import { useUserSetup } from './use-user-setup';
import { PromptHost } from './prompt-host';

// The window shell: a full-height sidebar, which its button and ⌘B hide and show, beside the main
// area; the window opens with it as the user last left it, and hiding it with the focus inside gives
// the focus to the focused panel. The window's top 40px form its title bar, which moves the window,
// shows no title and has no line beneath it: in the sidebar, the row of the window buttons; over the
// main area, the headers of the panels at the top, or an empty strip while none is open. Just after
// the window buttons, wherever they lie, the sidebar's button and then the button of the archived
// sessions keep their place, and after them the count of sessions waiting on the user shows the one
// that has waited longest. The sidebar's divider runs through the
// title bar, and while the sidebar is hidden, the window buttons lie over the main area. The sidebar
// holds the Workspaces section above the Sessions section, with a thin line between them; the main
// area holds the panel area, blank until something opens in it. The workspaces' tree rows and the
// Sessions list's rows drag into the panel area, which follows their presses, and tree rows open in
// it from the keyboard. New session opens a session page in the selected workspace's folder, or while
// there is none in the day's folder in ~/3mukon-code; a session in the lists shows in its first
// panel, or opens in one, and so does a file opened from a tree. The lists have a session's history
// read ahead as the user reaches for it, and search through the bridge. A session's menu archives,
// unarchives or removes it, and a removed session's panels close. Session pages and sessions fill
// their panels, titled by the session once it runs, a page going on as its session's page once it
// starts it, and files open in editors, which mark unsaved changes and ask about them before their
// panels close. What agents present opens beside their sessions as the panel area places it, a file in
// an editor and a result drawn as Markdown, an image or a table, its header naming the session. The archived sessions' button opens their panel, and ⌘, or the gear just after the
// app's name opens the settings' panel; each shows in one panel, which opening it again focuses. The
// gauge between them opens the Accounts panel, the same way, with each provider's sign-in and usage
// limits; a session page marks a provider that is not signed in and offers its sign-in, which runs
// the provider's own command in a terminal, and says beside the context in use when its provider has
// nearly used up a limit. ⌃` opens a terminal beside the focused panel, in that panel's folder, or
// else the selected workspace's, or else the home folder, and a workspace's menu opens one in its
// folder; a terminal's panel closing ends it. The window's language follows the settings. As the
// window opens, it asks for what session pages offer, each provider's models among them, so that a
// page has them when it opens. The menus and questions the main process asks the user show over it, in
// the app's own look.
export function App({ bridge }: { bridge: Bridge }) {
  const { t, i18n } = useTranslation();
  const [sidebarOpen, setSidebarOpen] = useState(!bridge.settings.initial.sidebarHidden);
  const sidebar = useRef<HTMLElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const beside = useRef<HTMLDivElement>(null);
  const sidebarId = useId();
  const workspaces = useWorkspaces(bridge.workspaces);
  // The archived session last opened from the archived list, as the list showed it, until the main
  // process gives it among the sessions the window has shown.
  const [opening, setOpening] = useState<SessionSummary | null>(null);
  const panels = usePanels();
  const sessions = useSessions(bridge.sessions, (id) => {
    for (const panel of panelsOf(panels.latest().layout)) {
      if (panel.content.kind === 'session' && panel.content.id === id) panels.close(panel.id);
    }
    setOpening((session) => (session?.id === id ? null : session));
  });
  const settings = useSettings(bridge.settings);
  const accounts = useAccounts(bridge.accounts);
  const [terminalViews] = useState(
    () => new TerminalViews(bridge.terminal, (code) => i18n.t('terminal.exited', { code })),
  );
  useEffect(() => terminalViews.connect(), [terminalViews]);
  const area = useRef<PanelAreaHandle>(null);
  // The file editors, whose rendered Markdown opens the files it links to in panels.
  const fileEditors = useFileEditors(bridge.files, {
    onOpenFile: (path) => {
      openItem({ kind: 'file', path });
    },
  });
  // The session whose oldest waiting request takes the keyboard focus, each time the key changes.
  const [requestFocus, setRequestFocus] = useState<{ sessionId: string; key: number } | null>(null);

  const openNewSession = () => {
    const selected = workspaces.workspaces.find(
      (workspace) => workspace.id === workspaces.selectedId,
    );
    const open = (folder: string) => {
      panels.open([{ kind: 'session-page', folder }]);
    };
    if (selected !== undefined) open(selected.path);
    else bridge.sessions.dayFolder().then(open, report);
  };

  // The first panel, in reading order, that shows the session, where a session in the lists shows and
  // its oldest waiting request takes the keyboard focus.
  const sessionPanel = (id: string) =>
    panelsOf(panels.layout).find(
      (panel) => panel.content.kind === 'session' && panel.content.id === id,
    );

  const openSession = (session: SessionSummary) => {
    if (session.archived === true) setOpening(session);
    const shown = sessionPanel(session.id);
    if (shown !== undefined) panels.focus(shown.id);
    else panels.open([{ kind: 'session', id: session.id, folder: session.cwd }]);
  };

  // The archived sessions' panel, or the settings', of which one shows: opening it again focuses it.
  const openOwnPanel = (content: PanelContent) => {
    const shown = panelsOf(panels.layout).find((panel) => sameContent(panel.content, content));
    if (shown !== undefined) panels.focus(shown.id);
    else panels.open([content]);
  };

  // A terminal beside the focused panel, in the folder given, or in the home folder for null.
  const openTerminal = (cwd: string | null) => {
    bridge.terminal.open(cwd).then((terminal) => {
      panels.open([{ kind: 'terminal', id: terminal.id, cwd: terminal.cwd }]);
    }, reportTerminal);
  };

  // The provider's own sign-in command, in a terminal beside the focused panel.
  const signIn = (provider: ProviderId) => {
    bridge.accounts.signIn(provider).then((terminal) => {
      panels.open([{ kind: 'terminal', id: terminal.id, cwd: terminal.cwd }]);
    }, reportTerminal);
  };

  const openAccounts = () => {
    openOwnPanel({ kind: 'accounts' });
  };

  // What session pages show of the providers' accounts.
  const accountViews: AccountViews = {
    signedOut: (provider) => accounts.of(provider)?.signIn.state === 'signed-out',
    signedIn: (provider) => accounts.of(provider)?.signIn.state === 'signed-in',
    signIn: (provider) => <SignInPrompt provider={provider} onSignIn={signIn} />,
    notice: (provider) => {
      const account = accounts.of(provider);
      return mostUsed(account?.usage) === undefined ? null : (
        <UsageNotice account={account} onOpen={openAccounts} />
      );
    },
  };

  // A session's menu, from either list.
  const showSessionMenu = (session: SessionSummary) => {
    bridge.sessions.showMenu(session.id).catch(reportMenu);
  };

  // What an archived session's row does without its menu: unarchive it, or remove it once the user
  // confirms.
  const actOnArchived = (session: SessionSummary, action: SessionAction) => {
    bridge.sessions.act(session.id, action).catch(reportMenu);
  };

  // Reads a session's history ahead of showing it, from either list.
  const readAhead = (session: SessionSummary) => {
    bridge.sessions.preload(session.id).catch(reportReadAhead);
  };

  // Shows a waiting session in its panel, with the focus on its oldest waiting request.
  const showWaiting = (session: SessionSummary) => {
    openSession(session);
    setRequestFocus((previous) => ({ sessionId: session.id, key: (previous?.key ?? 0) + 1 }));
  };

  // Hides or shows the sidebar, from its button or ⌘B; hiding it with the focus inside, where nothing
  // keeps it once hidden, first gives the focus to the focused panel.
  const toggleSidebar = useCallback(() => {
    if (sidebar.current?.contains(document.activeElement)) area.current?.focus();
    setSidebarOpen((open) => !open);
  }, []);

  // The window opens with the sidebar as the user last left it.
  useEffect(() => {
    bridge.settings.set({ sidebarHidden: !sidebarOpen }).catch(reportSidebar);
  }, [bridge.settings, sidebarOpen]);

  // How wide what lies beside the window buttons is, which the header of the panel beneath it leaves
  // room for while the sidebar is hidden (`--beside-window-buttons`).
  useLayoutEffect(() => {
    const [container, element] = [frame.current, beside.current];
    if (container === null || element === null) return;
    const measure = () => {
      container.style.setProperty('--beside-window-buttons', `${String(element.offsetWidth)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Beside the window buttons: the sidebar's button, the archived sessions' button, the accounts'
  // gauge, the settings' gear, whose panel ⌘, opens too, then the count of sessions waiting on the
  // user, which shows the one that has waited longest.
  const besideWindowButtons = (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarOpen ? t('sidebar.hide') : t('sidebar.show')}
        aria-expanded={sidebarOpen}
        aria-controls={sidebarId}
        title={sidebarOpen ? t('sidebar.hideTip') : t('sidebar.showTip')}
        className="grid size-5 shrink-0 place-items-center rounded-md text-faint [-webkit-app-region:no-drag] hover:bg-hover hover:text-ink"
      >
        <PanelLeft className="size-3.5" />
      </button>
      <ArchivedButton
        count={sessions.archived}
        onOpen={() => {
          openOwnPanel({ kind: 'archived' });
        }}
      />
      <AccountsButton onOpen={openAccounts} />
      <button
        type="button"
        onClick={() => {
          openOwnPanel({ kind: 'settings' });
        }}
        aria-label={t('settings.title')}
        title={t('settings.title')}
        className="grid size-5 shrink-0 place-items-center rounded-md text-faint [-webkit-app-region:no-drag] hover:bg-hover hover:text-ink"
      >
        <Gear className="size-3.5" />
      </button>
      <WaitingButton sessions={sessions.sessions} onShow={showWaiting} />
    </div>
  );

  // What the lists show of a session the window shows: in the Sessions list, or else among the others
  // whose pages the window has shown, archived ones, or as the archived list showed it until then.
  const summaryOf = (id: string): SessionSummary | undefined =>
    sessions.sessions.find((session) => session.id === id) ??
    sessions.shown.find((session) => session.id === id) ??
    (opening?.id === id ? opening : undefined);

  const openItem = (item: TreeItem) => {
    const shown = panelsOf(panels.layout).find(
      (panel) => panel.content.kind === 'file' && panel.content.path === item.path,
    );
    if (item.kind === 'file' && shown !== undefined) panels.focus(shown.id);
    else panels.open([contentOf(item)]);
  };

  // A session's name, as its panel's header gives it, for what it presents.
  const sessionName = (id: string): string => {
    const summary = summaryOf(id);
    if (summary === undefined) return t('panels.someSession');
    return summary.title === undefined || summary.title === ''
      ? t(`providers.${summary.provider}`)
      : summary.title;
  };

  // The results agents present, read from main as their panels show them.
  const artifacts = useArtifacts(
    bridge.presentations,
    panelsOf(panels.layout).flatMap((panel) =>
      panel.content.kind === 'artifact' ? [panel.content.artifactId] : [],
    ),
  );

  // The automation of the sessions the panels show, whose activity records what the app's tools did,
  // and of the sessions that own the tabs and applications the panels show, which say how they use
  // them.
  const automation = useAutomation(
    bridge.automation,
    panelsOf(panels.layout).flatMap((panel) =>
      panel.content.kind === 'session'
        ? [panel.content.id]
        : (panel.content.kind === 'browser' || panel.content.kind === 'computer') &&
            panel.presented !== undefined
          ? [panel.presented.owner]
          : [],
    ),
  );
  // The tabs the browser panels show, each by the session that owns it.
  const shownTab = useBrowserTabs(
    bridge.browser,
    panelsOf(panels.layout).flatMap((panel) =>
      panel.content.kind === 'browser' && panel.presented !== undefined
        ? [{ owner: panel.presented.owner, tabId: panel.content.tabId }]
        : [],
    ),
  );
  // What a tab's session does with it, as its automation says.
  const tabUse = (owner: string, ref: BrowserTabRef | null): TabUse => {
    const live = automation.get(owner);
    if (live === undefined || ref === null) return NO_USE;
    const using = live.operations.filter(
      (operation) => operation.target.id === ref.id && operation.state !== 'ended',
    );
    const stopping =
      live.phase === 'stopping' || using.some((operation) => operation.state === 'stopping');
    return {
      held: using.length > 0,
      acting:
        (live.phase === 'acting' || live.phase === 'observing' || stopping) &&
        using.some((operation) => operation.state === 'active' || operation.state === 'stopping'),
      stopping,
      waiting: live.pendingApprovals.some((approval) => approval.target.ref.id === ref.id),
    };
  };
  // The presentations with a panel open.
  const openPresentations = new Set(
    panelsOf(panels.layout).flatMap((panel) =>
      panel.presented === undefined ? [] : [panel.presented.presentationId],
    ),
  );
  // Under each tool call by which a session presented something, the presentation, with Show.
  const presentationsUnder =
    (sessionId: string) =>
    (toolId: string): ReactNode => {
      const call = automation
        .get(sessionId)
        ?.recentCalls.find(
          (record) =>
            record.family === 'panel' &&
            record.toolName === 'panel_present' &&
            record.outcome?.status === 'verified' &&
            record.providerEntry?.providerToolId === toolId,
        );
      if (call?.family !== 'panel') return null;
      return call.presentations.map((presentation) => (
        <PresentationEntry
          key={presentation.id}
          title={presentation.title}
          open={openPresentations.has(presentation.id)}
          onShow={() =>
            area.current?.show(sessionId, presentation.id) ?? Promise.resolve('unavailable')
          }
        />
      ));
    };

  // In place of the provider's own entry for each call of the app's browser and computer tools, what
  // the call did, as the session's automation records it, with its screenshots read once it shows.
  // Browser and computer use's setup, read while the settings show, and the steps the user's click
  // takes in them and in the sessions' setup notices.
  const setup = useUserSetup(
    bridge.setup,
    panelsOf(panels.layout).some((panel) => panel.content.kind === 'settings'),
  );
  const setupStep = (action: SetupAction): Promise<boolean> =>
    bridge.setup.act(action).then((outcome) => outcome.status === 'verified');
  const computerSteps: ComputerSteps = {
    open: (permission) => setupStep({ kind: 'open-permission', permission }),
    restart: () => setupStep({ kind: 'restart-helper' }),
  };
  const watchChrome = useCallback(
    (receive: (chrome: SetupSnapshot['chrome']) => void) =>
      bridge.setup.subscribe((snapshot) => {
        receive(snapshot.chrome);
      }),
    [bridge.setup],
  );
  const allowChromeProfiles = async () => {
    const result = await bridge.setup.act({ kind: 'allow-chrome-profiles' });
    if (result.status === 'cancelled-before-dispatch') return null;
    // Main refuses a folder other than Chrome's as an invalid request.
    if (result.status === 'refused' && result.code === 'invalid-request')
      throw new WrongChromeFolder();
    if (result.status !== 'verified') throw new Error('Chrome profiles could not be read.');
    return (await bridge.setup.snapshot()).chrome;
  };
  // The steps of a session's Chrome connection notice.
  const browserSteps: BrowserSetupSteps = {
    chrome: () => bridge.setup.snapshot().then((snapshot) => snapshot.chrome),
    watchChrome,
    allowProfiles: allowChromeProfiles,
    connectChrome: (profileId) =>
      setupStep({ kind: 'connect-browser', browser: 'chrome', profileId }),
    copyFolder: (path) => bridge.sessions.copyText(path),
  };
  // Under a call refused until something is set up, the notice with the step that starts it.
  const setupNotice = (requirement: SetupRequirement): ReactNode => {
    if (requirement.kind === 'browser') return <BrowserSetupNotice steps={browserSteps} />;
    if (requirement.kind === 'permission') {
      return (
        <ComputerSetupNotice
          need={{ kind: 'permission', permission: requirement.permission }}
          steps={computerSteps}
        />
      );
    }
    return <ComputerSetupNotice need={{ kind: 'restart-helper' }} steps={computerSteps} />;
  };

  const automationCalls =
    (sessionId: string): RenderToolCall =>
    (item) => {
      const record = automation
        .get(sessionId)
        ?.recentCalls.find((call) => call.providerEntry?.providerToolId === item.id);
      if (record === undefined) return undefined;
      // A presentation shows as its own line, with Show, in the provider's entry's place.
      if (record.family === 'panel') {
        return record.toolName === 'panel_present' &&
          record.outcome?.status === 'verified' &&
          record.presentations.length > 0
          ? null
          : undefined;
      }
      const detail = record.outcome?.status === 'refused' ? record.outcome.detail : undefined;
      // The approval the call asked for, once answered.
      const approval = record.approval?.answer ? record.approval : null;
      return (
        <>
          {approval !== null && (
            <AnsweredHostApproval
              approval={approval}
              grant={grantStanding(sessionId, approval.grantId, record.grantEnd)}
              agent={agentOf(sessionId)}
              {...(approval.grantId === null
                ? {}
                : { onEnd: endGrant(sessionId, approval.grantId) })}
            />
          )}
          <AutomationCall
            record={record}
            loadFrames={() => callFrames(sessionId, record.callId)}
            {...(detail?.kind === 'setup' ? { notice: setupNotice(detail.requirement) } : {})}
          />
        </>
      );
    };
  // The name of a session's agent, as its provider is called.
  const agentOf = (sessionId: string): string => {
    const provider = summaryOf(sessionId)?.provider;
    return provider === undefined ? t('panels.someSession') : t(`providers.${provider}`);
  };
  // How an answered approval's grant stands, as the session's automation last said: in force, ended,
  // or none.
  const grantStanding = (
    sessionId: string,
    grantId: string | null,
    end: GrantEndRecord | null,
  ): GrantStanding => {
    if (grantId === null) return null;
    const live = automation.get(sessionId);
    if (live?.grants.some((grant) => grant.id === grantId) === true) return 'active';
    return end ?? live?.endedGrants.find((ended) => ended.grant.id === grantId) ?? null;
  };
  // Ends a session's grant from the user's click; whether it did.
  const endGrant = (sessionId: string, grantId: string) => () =>
    bridge.automation.endGrant(sessionId, grantId).then((outcome) => outcome.status === 'verified');
  // The operation's approval a session's automation has waited on longest, if any.
  const oldestApproval = (sessionId: string) =>
    automation
      .get(sessionId)
      ?.pendingApprovals.reduce<HostApproval | undefined>(
        (first, request) =>
          first === undefined || request.requestedAt < first.requestedAt ? request : first,
        undefined,
      );
  // Whether the request a session has waited on longest is one of its automation's approvals, which
  // then takes the focus that showing the waiting session gives: the lists' waiting time is the
  // oldest of the provider's requests and these approvals.
  const approvalWaitsLongest = (sessionId: string): boolean => {
    const oldest = oldestApproval(sessionId);
    if (oldest === undefined) return false;
    const since = summaryOf(sessionId)?.waitingSince;
    return since === undefined || oldest.requestedAt <= since;
  };
  // The operations' approvals a session's automation waits on, at its activity's end, the focus
  // key going to the oldest.
  const hostRequestsOf = (sessionId: string, focusKey?: number): ReactNode => {
    const waiting = automation.get(sessionId)?.pendingApprovals ?? [];
    if (waiting.length === 0) return undefined;
    const oldest = oldestApproval(sessionId);
    return waiting.map((request) => (
      <HostApprovalBlock
        key={request.id}
        request={request}
        agent={agentOf(sessionId)}
        {...(focusKey !== undefined && request.id === oldest?.id ? { focusKey } : {})}
        onAnswer={(answer) =>
          bridge.automation.answer(sessionId, request.id, answer).then((outcome) => {
            if (outcome.status !== 'verified') throw new Error(`The answer was ${outcome.status}.`);
          })
        }
      />
    ));
  };
  const callFrames = (sessionId: string, callId: string): Promise<MessageImage[]> =>
    bridge.automation
      .callFrames(sessionId, callId)
      .then((outcome) =>
        outcome.status === 'verified'
          ? outcome.value.map((frame) => frame.image)
          : Promise.reject(new Error(`The call's screenshots are ${outcome.status}.`)),
      );
  // Closes a tab a session uses, as its row above the composer asks, and then the panels that show
  // it, which would only say that it has closed.
  const closeTab = (sessionId: string, target: TargetSummary): Promise<boolean> =>
    target.ref.kind === 'browser-tab'
      ? bridge.browser
          .command(
            sessionId,
            { id: target.ref.id, generation: target.ref.generation, kind: 'browser-tab' },
            { kind: 'close' },
          )
          .then((outcome) => {
            if (outcome.status !== 'verified') return false;
            const content = usedContent(target);
            for (const panel of panelsOf(panels.latest().layout))
              if (content !== null && sameContent(panel.content, content)) panels.close(panel.id);
            return true;
          })
      : Promise.resolve(false);
  // Whether a panel shows a tab or an application a session uses.
  const shownUsed = (target: TargetSummary): boolean => {
    const content = usedContent(target);
    return (
      content !== null &&
      panelsOf(panels.layout).some((panel) => sameContent(panel.content, content))
    );
  };
  // Presents beside the session each tab or application it uses, as the user asks from the line
  // above its composer; true once each is shown.
  const showUsed = (sessionId: string, targets: readonly TargetSummary[]): Promise<boolean> =>
    Promise.all(
      targets
        .map(usedContent)
        .filter((content) => content !== null)
        .map(
          (content) => area.current?.showUsed(sessionId, content) ?? Promise.resolve('unavailable'),
        ),
    ).then((outcomes) => outcomes.length > 0 && outcomes.every((outcome) => outcome === 'shown'));

  const view = (panel: Panel): PanelView => {
    const { content } = panel;
    // A presented panel names the session it comes from.
    const from =
      panel.presented === undefined ? {} : { detail: sessionName(panel.presented.owner) };
    if (content.kind === 'file') {
      const file = fileEditors.panel(panel.id, content.path);
      return {
        body: file.body,
        unsaved: file.unsaved,
        confirmClose: file.confirmClose,
        ...(file.actions === undefined ? {} : { actions: file.actions }),
        ...from,
      };
    }
    if (content.kind === 'artifact') {
      const state = artifacts.get(content.artifactId) ?? { status: 'loading' };
      return {
        title:
          state.status === 'ready'
            ? state.artifact.title
            : (panel.presented?.title ?? t('panels.result')),
        ...from,
        body: <ArtifactView state={state} />,
      };
    }
    if (content.kind === 'browser' && panel.presented !== undefined) {
      const { owner, presentationId } = panel.presented;
      const { ref, state } = shownTab(owner, content.tabId);
      const place = placeOf(state?.address ?? null);
      const title = state?.title === undefined || state.title === '' ? null : state.title;
      const shared =
        state === null || state === undefined
          ? null
          : sharingTag(sharingWords(state.sharing, state.browser, state.profile), t);
      const use = tabUse(owner, ref);
      const session = sessionName(owner);
      return {
        title: title ?? place?.host ?? panel.presented.title,
        ...(title !== null && place !== null
          ? { detail: place.host, detailTitle: place.full }
          : {}),
        ...(use.held
          ? { status: 'running', statusLabel: t('browser.panel.inUse', { session }) }
          : {}),
        ...(shared === null ? {} : { actions: <Tag>{shared}</Tag> }),
        body: (
          <BrowserPanel
            state={state}
            session={session}
            use={use}
            onCommand={(command) =>
              ref === null
                ? Promise.resolve(false)
                : bridge.browser
                    .command(owner, ref, command)
                    .then((outcome) => outcome.status === 'verified')
            }
            onStop={() =>
              bridge.automation.stop(owner).then((outcome) => outcome.status === 'verified')
            }
            onShowQuestion={() => {
              const summary = summaryOf(owner);
              if (summary !== undefined) showWaiting(summary);
            }}
            {...(ref === null || state === null || state === undefined
              ? {}
              : {
                  page: (onFrame: (capturedAt: number | null) => void) => (
                    <BrowserPageView
                      views={bridge.browser}
                      owner={owner}
                      presentation={presentationId}
                      tab={ref}
                      title={title ?? place?.host ?? ''}
                      address={place?.full ?? ''}
                      {...(state.browser === 'embedded'
                        ? {}
                        : {
                            previewRevision: [
                              state.documentGeneration,
                              state.geometryGeneration,
                            ].join(':'),
                          })}
                      focused={panel.id === panels.focusedId}
                      onFocus={() => {
                        panels.focus(panel.id);
                      }}
                      onFrame={onFrame}
                    />
                  ),
                })}
          />
        ),
      };
    }
    if (content.kind === 'computer' && panel.presented !== undefined) {
      const { owner, presentationId } = panel.presented;
      const live = automation.get(owner);
      const summary = live?.resources.find((resource) => resource.ref.id === content.targetId);
      const application =
        live === undefined || summary === undefined ? undefined : applicationOf(live, summary);
      const name = summary?.applicationName ?? summary?.name ?? panel.presented.title;
      const use = applicationUse(live, summary, application);
      const session = sessionName(owner);
      const delivery =
        live === undefined || application === undefined
          ? 'background'
          : deliveryOn(live, application.ref);
      return {
        title: name,
        detail: session,
        ...(use.held
          ? { status: 'running', statusLabel: t('computer.preview.inUse', { session }) }
          : {}),
        actions: <Tag>{t(`sessions.automation.delivery.${delivery}`)}</Tag>,
        body: (
          <ComputerPreviewView
            port={bridge.computer}
            owner={owner}
            presentation={presentationId}
            target={content.targetId}
            name={name}
            session={session}
            use={use}
            onStop={() =>
              bridge.automation.stop(owner).then((outcome) => outcome.status === 'verified')
            }
            onAllow={() => computerSteps.open('screen-recording')}
          />
        ),
      };
    }
    if (content.kind === 'browser' || content.kind === 'computer') {
      return {
        title: panel.presented?.title ?? '',
        ...from,
        body: <Notice>{t('panels.notYet')}</Notice>,
      };
    }
    if (content.kind === 'settings') {
      return {
        title: t('settings.title'),
        body: (
          <SettingsPanel settings={settings.settings} onChange={settings.change}>
            <BrowserUseSetting
              setup={setup}
              onClearSignIns={() => setupStep({ kind: 'clear-app-sign-ins' })}
              chromeSteps={{
                allowProfiles: allowChromeProfiles,
                connect: (profileId) =>
                  setupStep({ kind: 'connect-browser', browser: 'chrome', profileId }),
                disconnect: (profileId) =>
                  setupStep({ kind: 'disconnect-browser', browser: 'chrome', profileId }),
                copyFolder: (path) => bridge.sessions.copyText(path),
              }}
            />
            <ComputerUseSetting setup={setup?.computer ?? null} steps={computerSteps} />
          </SettingsPanel>
        ),
      };
    }
    if (content.kind === 'terminal') {
      return {
        title: t('terminal.title'),
        body: <TerminalPanel views={terminalViews} id={content.id} />,
        confirmClose: () => bridge.terminal.confirmClose(content.id),
      };
    }
    if (content.kind === 'accounts') {
      return {
        title: t('accounts.title'),
        body: (
          <AccountsPanel bridge={bridge.accounts} accounts={accounts.accounts} onSignIn={signIn} />
        ),
      };
    }
    if (content.kind === 'archived') {
      return {
        title: t('sessions.archived'),
        detail: t('sessions.archivedPanel.count', { count: sessions.archived }),
        body: (
          <ArchivedPanel
            bridge={bridge.sessions}
            count={sessions.archived}
            onOpenSession={openSession}
            onSessionMenu={showSessionMenu}
            onAct={actOnArchived}
            onReadAhead={readAhead}
          />
        ),
      };
    }
    const sessionId = content.kind === 'session' ? content.id : null;
    const summary = sessionId === null ? undefined : summaryOf(sessionId);
    return {
      ...(summary === undefined
        ? {}
        : {
            title: summary.title ?? t(`providers.${summary.provider}`),
            status: statusDots[summary.status],
            statusLabel: t(`sessions.status.${summary.status}`),
          }),
      body: (
        <SessionPage
          bridge={bridge.sessions}
          folder={content.folder}
          sessionId={sessionId}
          {...(summary === undefined ? {} : { summary })}
          {...(summary?.parent === undefined ? {} : { parentTitle: sessionName(summary.parent) })}
          accounts={accountViews}
          {...(sessionId === null
            ? {}
            : {
                renderToolExtra: presentationsUnder(sessionId),
                renderToolCall: automationCalls(sessionId),
                aboveComposer: (
                  <>
                    <AutomationLine
                      state={automation.get(sessionId)}
                      shown={shownUsed}
                      onShow={(targets) => showUsed(sessionId, targets)}
                      onClose={(target) => closeTab(sessionId, target)}
                    />
                    <GrantsLine
                      grants={automation.get(sessionId)?.grants ?? []}
                      onEnd={(grantId) => endGrant(sessionId, grantId)()}
                    />
                  </>
                ),
                hostRequests: hostRequestsOf(
                  sessionId,
                  requestFocus?.sessionId === sessionId &&
                    sessionPanel(sessionId)?.id === panel.id &&
                    approvalWaitsLongest(sessionId)
                    ? requestFocus.key
                    : undefined,
                ),
                renderRequest: (item, place) => (
                  <Request
                    item={item}
                    {...(requestFocus?.sessionId === sessionId &&
                    place.oldestWaiting &&
                    sessionPanel(sessionId)?.id === panel.id &&
                    !approvalWaitsLongest(sessionId)
                      ? { focusKey: requestFocus.key }
                      : {})}
                    answering={{
                      approval: (requestId, answer) =>
                        bridge.approvals.answerApproval(sessionId, requestId, answer),
                      question: (requestId, answer) =>
                        bridge.approvals.answerQuestion(sessionId, requestId, answer),
                    }}
                  />
                ),
              })}
          onStarted={(started) => {
            panels.show(panel.id, { kind: 'session', id: started, folder: content.folder });
          }}
        />
      ),
    };
  };

  useEffect(() => {
    preloadOffers(bridge.sessions);
  }, [bridge]);

  // A terminal whose panel has closed ends, with whatever runs in it.
  const shownTerminals = useRef(new Set<string>());
  useEffect(() => {
    const shown = new Set(
      panelsOf(panels.layout).flatMap((panel) =>
        panel.content.kind === 'terminal' ? [panel.content.id] : [],
      ),
    );
    for (const id of shownTerminals.current) {
      if (shown.has(id)) continue;
      terminalViews.dispose(id);
      bridge.terminal.close(id).catch(reportTerminal);
    }
    shownTerminals.current = shown;
  }, [panels.layout, terminalViews, bridge]);

  // ⌃` opens a terminal beside the focused panel, in its folder, or else the selected workspace's,
  // or else the home folder.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const onlyControl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (!onlyControl || event.code !== 'Backquote') return;
      event.preventDefault();
      const focused = panelsOf(panels.layout).find((panel) => panel.id === panels.focusedId);
      const selected = workspaces.workspaces.find(
        (workspace) => workspace.id === workspaces.selectedId,
      );
      openTerminal(
        (focused === undefined ? null : folderOf(focused.content)) ?? selected?.path ?? null,
      );
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  // ⇧⌘A shows the request that has waited longest, and the next waiting session's at each press.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shiftCommand = event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey;
      if (!shiftCommand || event.key.toLowerCase() !== 'a') return;
      const focused = panelsOf(panels.layout).find((panel) => panel.id === panels.focusedId);
      const next = nextWaiting(
        sessions.sessions,
        focused?.content.kind === 'session' ? focused.content.id : undefined,
      );
      if (next === undefined) return;
      event.preventDefault();
      showWaiting(next);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  // ⌘, opens the settings' panel, or focuses it.
  useEffect(() => {
    const openSettings = (event: KeyboardEvent) => {
      const onlyCommand = event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
      if (!onlyCommand || event.key !== ',') return;
      event.preventDefault();
      openOwnPanel({ kind: 'settings' });
    };
    window.addEventListener('keydown', openSettings);
    return () => {
      window.removeEventListener('keydown', openSettings);
    };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const onlyCommand = event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
      if (!onlyCommand || event.key.toLowerCase() !== 'b') return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [toggleSidebar]);

  return (
    <div ref={frame} className="relative flex h-full">
      {/* Just after macOS's window buttons, where it stays as the sidebar opens and closes while the
          sidebar's part of the title bar or the header of the panel at the top left moves beneath it. */}
      <div ref={beside} className="absolute top-0 left-[84px] z-30 flex h-10 items-center">
        {besideWindowButtons}
      </div>
      <aside
        ref={sidebar}
        id={sidebarId}
        aria-label={t('sidebar.label')}
        inert={!sidebarOpen}
        className={`shrink-0 overflow-hidden select-none motion-safe:transition-[width] motion-safe:duration-200 ${sidebarOpen ? 'w-[220px]' : 'w-0'}`}
      >
        <div className="flex h-full w-[220px] flex-col border-r border-line">
          {/* The sidebar's part of the title bar, where macOS draws the traffic lights, under what lies
              beside them; no line separates it from the rest of the sidebar. */}
          <div className="relative h-10 shrink-0 [-webkit-app-region:drag]">
            <WindowButtonsHole />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 px-2.5 pb-3.5">
            {/* The app's name, bold and compact, just below the title bar. */}
            <div className="shrink-0 truncate px-2 leading-5 font-bold">3mukon-code</div>
            <WorkspacesSection
              bridge={bridge.workspaces}
              list={workspaces}
              onPressItem={(item, press) => {
                area.current?.dragItem(item, nameOf(item.path), press);
              }}
              onOpenItem={openItem}
              onOpenInTerminal={openTerminal}
            />
            {/* A thin line between the two sections, as wide as their rows, halfway between them. */}
            <div aria-hidden="true" className="-my-1 shrink-0 border-t border-line" />
            <SessionsSection
              sessions={sessions.sessions}
              folders={workspaces.workspaces}
              bridge={bridge.sessions}
              onNewSession={openNewSession}
              onOpenSession={openSession}
              onSessionMenu={showSessionMenu}
              onPressSession={(session, press) => {
                const item = { kind: 'session', id: session.id, folder: session.cwd } as const;
                const title =
                  session.title === undefined || session.title === ''
                    ? t(`providers.${session.provider}`)
                    : session.title;
                area.current?.dragItem(item, title, press);
              }}
              onReadAhead={readAhead}
            />
          </div>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1">
        <PanelArea
          ref={area}
          panels={panels}
          bridge={bridge.panels}
          presentations={bridge.presentations}
          sessionName={sessionName}
          view={view}
          clearsWindowButtons={!sidebarOpen}
        />
      </main>
      <PromptHost bridge={bridge.prompts} />
      <TooltipHost enabled={settings.settings.tooltips} />
    </div>
  );
}

// The last name in a path, as the tree shows a row, or the path itself for the startup disk's root.
function nameOf(path: string): string {
  const name = path.replace(/\/+$/, '').split('/').at(-1);
  return name === undefined || name === '' ? path : name;
}

function report(error: unknown): void {
  console.error('The session page could not open:', error);
}

function reportMenu(error: unknown): void {
  console.error('The session’s menu could not do that:', error);
}

function reportReadAhead(error: unknown): void {
  console.error('The session’s history could not be read ahead:', error);
}

function reportSidebar(error: unknown): void {
  console.error('Whether the sidebar is hidden could not be kept:', error);
}

function reportTerminal(error: unknown): void {
  console.error('The terminal could not open:', error);
}

// The application a target belongs to, as the session's automation lists it: the target itself for an
// application, and for a window the application its summary identifies.
function applicationOf(
  live: AutomationLiveState,
  target: TargetSummary,
): TargetSummary | undefined {
  if (target.ref.kind === 'application') return target;
  const parent = target.application;
  if (!parent) return undefined;
  return live.resources.find(
    ({ ref }) =>
      ref.id === parent.id && ref.generation === parent.generation && ref.kind === 'application',
  );
}

// What a window's session does with its application, as its automation says.
function applicationUse(
  live: AutomationLiveState | undefined,
  target: TargetSummary | undefined,
  application: TargetSummary | undefined,
): ApplicationUse {
  if (live === undefined || target === undefined) return NO_APPLICATION_USE;
  const ids = new Set([target.ref.id, ...(application === undefined ? [] : [application.ref.id])]);
  const using = live.operations.filter(
    (operation) => ids.has(operation.target.id) && operation.state !== 'ended',
  );
  const stopping =
    live.phase === 'stopping' || using.some((operation) => operation.state === 'stopping');
  return {
    held: using.length > 0,
    acting:
      (live.phase === 'acting' || live.phase === 'observing' || stopping) &&
      using.some((operation) => operation.state === 'active' || operation.state === 'stopping'),
    stopping,
    userHas:
      live.pausedTargets?.some(
        ({ target, reason }) =>
          reason === 'user-input' &&
          target.id === application?.ref.id &&
          target.generation === application.ref.generation,
      ) ?? false,
  };
}

// A page's address as a browser panel's header names it: its host, and its host and path.
function placeOf(address: string | null): { host: string; full: string } | null {
  if (address === null) return null;
  try {
    const url = new URL(address);
    return { host: url.host, full: `${url.host}${url.pathname === '/' ? '' : url.pathname}` };
  } catch {
    return null;
  }
}

// What the panel area shows of a target a session uses: a tab of the browser, or an application or one
// of its windows; nothing for a system dialog, which only its application shows.
function usedContent(target: TargetSummary): UsedContent | null {
  switch (target.ref.kind) {
    case 'browser-tab':
      return { kind: 'browser', tabId: target.ref.id };
    case 'application':
    case 'window':
      return { kind: 'computer', targetId: target.ref.id };
    case 'system-dialog':
      return null;
  }
}
