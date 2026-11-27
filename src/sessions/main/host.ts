import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type {
  ApprovalAnswer,
  MessageImage,
  ModelOption,
  PermissionMode,
  ProviderId,
  QuestionAnswer,
  QuestionRequest,
  ReasoningEffort,
  SandboxLevel,
  SessionEvent,
} from '../shared/events';
import {
  applyEvent,
  initialSessionState,
  openRequests,
  sessionStatus,
  type SessionState,
} from '../shared/session-state';
import type {
  SessionAction,
  SessionEventsListener,
  SessionList,
  SessionListChange,
  SessionSearch,
  SessionSettings,
  SessionSnapshot,
  SessionSummary,
} from '../shared/sessions';
import type {
  ChildModels,
  ChildRequest,
  CoordinatedSession,
  HostContextDelivery,
  HostTurnContext,
  InboxEntry,
  Provider,
  ProviderSession,
  SessionAutomation,
  SessionAutomationHost,
  SessionCoordinator,
  SessionEventListener,
  StartOptions,
} from './provider';
import { CHILD_LIMIT, MESSAGE_LIMITS, type InboxNotice, type InboxReport } from '../shared/inbox';
import { memoryInboxStorage, SessionInboxes, type InboxMessage } from './inbox';
import type { SessionRecord, SessionRecords } from './records';
import { cleanTitle, ranAWhile, TITLE_ATTEMPTS, titlePrompt, type TurnProgress } from './titles';
import { effortToSet, modelInUse, titleEffort } from '../shared/efforts';
import { searchWords } from '../shared/search';
import { matchOf, memoryTextStorage, textOf, type TextStorage } from './texts';

// How long a child that ends itself waits before it closes, so that the result of its call reaches
// it.
const SELF_END_MS = 1_000;

// The sandbox levels from the narrowest to the widest.
const SANDBOX_ORDER: readonly SandboxLevel[] = ['read-only', 'workspace-write', 'full-access'];

// How long a provider has to list its models before the list fails.
const MODELS_TIMEOUT_MS = 60_000;
// How long a list of models found counts as fresh for a page before its first message, so that pages
// opened, or gateways switched between, in quick succession share one listing.
const MODELS_FRESH_MS = 15_000;

// The events after which a session's text is kept anew: its history read, a turn ended, the session
// closed.
const TEXT_EVENTS = new Set<SessionEvent['type']>(['history', 'turn-ended', 'closed']);

// How many sessions' texts a search reads at a time.
const SEARCH_READS = 16;

// What a history holds that the host leaves out of it: the settings it reports, since the app keeps
// the settings a session last had for itself, and the ends of a replay or a session.
const UNSHOWN_PAST = new Set<SessionEvent['type']>([
  'mode',
  'settings',
  'models',
  'replay-finished',
  'closed',
]);

// What the host asks the user about a session, attached to the window that asked.
export interface SessionsMenuUi {
  // The session's menu at the pointer: Archive, or Unarchive for an archived session, and Remove from
  // List; resolves with the user's choice, or null.
  sessionMenu(session: SessionSummary): Promise<SessionAction | null>;
  // Asks before a session that is working is archived, which stops it; resolves with whether the user
  // confirmed.
  confirmArchive(session: SessionSummary): Promise<boolean>;
  // Asks before a session leaves the app's lists; resolves with whether the user confirmed.
  confirmRemove(session: SessionSummary): Promise<boolean>;
}

interface Hosted {
  id: string;
  provider: ProviderId;
  cwd: string;
  // The provider's id for the session, once the provider has started it; the session is listed from
  // then on, or, for one started with a message, once that message is in it or has failed to go.
  sessionId?: string;
  // Whether the session was started with a message that is neither in it yet nor failed to go, so
  // that its row shows that message and its running turn from the first.
  sending?: boolean;
  // The model and effort for which the host last set the session's starting effort, so that it asks
  // once for each.
  effortSet?: string;
  // How long the session's turns have run in this run and how many have ended, and since when the
  // running turn has run, by which the host tells when the session has run for a while (ADR-0035).
  progress: TurnProgress;
  turnSince?: number;
  // The title written for the session once it had run for a while, how many times one was asked for
  // in this run, and whether one is being written.
  titled?: string;
  titleAsked: number;
  titling?: boolean;
  // The session that started the session, for a child (ADR-0036).
  parent?: string;
  // Whether the host has closed, or is closing, the session's current run itself, so that neither its
  // end nor an interruption on the way to it is reported to its parent (ADR-0042).
  closedByHost?: true;
  // Whether the host is telling the session of its new messages in a turn of its own.
  waking?: boolean;
  // When the user last sent the session a message or a turn of it ended.
  activeAt: number;
  archived: boolean;
  // The settings the session started or resumed with, until it reports its own.
  chosen: SessionSettings;
  // Folded from every event of the session: from the first, for a session started in this run, and
  // otherwise from its history.
  state: SessionState;
  // How many events have been folded.
  seq: number;
  // How many times the session has started or resumed in this run; only the provider session of the
  // latest is heard.
  runs: number;
  // The provider's session, from the session's latest start or resume.
  session?: ProviderSession;
  automation?: SessionAutomation;
  // Since when the session's oldest operation approval has waited for the user's answer, as its
  // automation reports it, and what stops that report.
  approvalsSince?: number;
  stopWaiting?: () => void;
  // The read of a session of an earlier run from its provider's history, once it has begun.
  reading?: Promise<void>;
  // The window has asked for the session's snapshot in this run, so that the lists give the session
  // while its page may show, even where the Sessions list does not hold it.
  shown: boolean;
  // What the lists last reported of the session.
  summary?: SessionSummary;
}

// The sessions started in the app, which run in the main process through the providers' adapters:
// those open in this run, and those that are not running, from an earlier run or whose provider
// stopped, which a message resumes. Each session's state is folded from its events as they arrive; a
// session of an earlier run shows its history, read from its provider's store without resuming it.
// Listeners hear whenever what the lists show changes: the Sessions list, which holds the sessions the
// records keep and any that is open, how many sessions are archived, and the others whose pages the
// window has shown; the archived sessions themselves are given only when asked for. Event listeners
// hear every event. The records keep the sessions the app starts, every archived one and the 1,000
// others active last, with their titles, latest activity and the settings they last had, for later
// runs; sessions started in a provider's own tools are never listed.
export class SessionHost {
  private readonly providers: ReadonlyMap<ProviderId, Provider>;
  private readonly records: SessionRecords;
  private readonly sessions = new Map<string, Hosted>();
  // The sessions being resumed, by the app's id.
  private readonly resuming = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(list: SessionListChange) => void>();
  private readonly eventListeners = new Set<SessionEventsListener>();
  // The models each provider and gateway offer in each folder: the last list found, with when, and the
  // listing under way.
  private readonly modelLists = new Map<string, { models: ModelOption[]; at: number }>();
  private readonly modelListings = new Map<string, Promise<ModelOption[]>>();
  // The text of each session's messages, which a search by conversation reads (ADR-0014): the
  // sessions that have one, once listed, and those whose history could not be read in this run.
  private readonly texts: TextStorage;
  private readonly stored = new Set<string>();
  private readonly textsListed: Promise<void>;
  private readonly unreadable = new Set<string>();
  // Set as the app quits, which stops the catch-up.
  private closing = false;
  // How many children each session is starting, which count towards its limit until they run.
  private readonly childStarts = new Map<string, number>();
  // What each session closing as the app quits calls as it ends, by session.
  private readonly ending = new Map<string, () => void>();

  constructor(
    providers: readonly Provider[],
    records: SessionRecords,
    texts: TextStorage = memoryTextStorage(),
    private readonly automation?: SessionAutomationHost,
    private readonly inboxes: SessionInboxes = new SessionInboxes(memoryInboxStorage()),
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
    this.records = records;
    this.texts = texts;
    for (const record of records.all()) {
      const hosted = pastSession(record);
      hosted.summary = this.summaryOf(hosted, record.sessionId);
      this.sessions.set(hosted.id, hosted);
    }
    this.textsListed = texts.ids().then((ids) => {
      for (const id of ids) this.stored.add(id);
    }, reportText);
  }

  // The providers sessions can start with, in the order the app gave them.
  providerIds(): ProviderId[] {
    return [...this.providers.keys()];
  }

  gateways(providerId: ProviderId): Promise<string[]> {
    return this.provider(providerId).listGateways();
  }

  // Found without starting a session, for the folder a page would start one in where it gives one, and
  // kept once found. A page before its first message asks for them fresh, since the provider's settings
  // may have changed since, and gets a list found within the last 15 seconds or a new one; one listing runs at
  // a time for each provider, gateway and folder. A list that fails, or that the provider has not found
  // within a minute, leaves the one kept as it was, and is asked for again next time.
  models(
    providerId: ProviderId,
    gateway: string | null,
    folder: string | null = null,
    fresh = false,
  ): Promise<ModelOption[]> {
    const provider = this.provider(providerId);
    const key = `${providerId}\n${gateway ?? ''}\n${folder ?? ''}`;
    const listing = this.modelListings.get(key);
    if (listing !== undefined) return listing;
    const kept = this.modelLists.get(key);
    if (kept !== undefined && (!fresh || Date.now() - kept.at < MODELS_FRESH_MS)) {
      return Promise.resolve(kept.models);
    }
    const listed = withinTime(
      folder === null ? provider.listModels(gateway) : provider.listModels(gateway, folder),
      MODELS_TIMEOUT_MS,
      `${providerId} did not list its models in time.`,
    ).then((models) => {
      this.modelLists.set(key, { models, at: Date.now() });
      return models;
    });
    this.modelListings.set(key, listed);
    const done = () => {
      if (this.modelListings.get(key) === listed) this.modelListings.delete(key);
    };
    listed.then(done, done);
    return listed;
  }

  // Starts a session in a folder and resolves with the app's id for it once the provider has
  // started it and taken the message it is started with, if any. A session started with a message
  // is listed once the message is in it, as the provider reports it at once, so that its row shows
  // the message and the running turn from the first, rather than its provider's name and idle for a
  // moment; a message that fails to go leaves it listed as it is, and the start rejects. It rejects
  // when the folder is not one, or the provider is not available or refuses.
  async start(
    providerId: ProviderId,
    options: StartOptions,
    message?: { text: string; images?: MessageImage[] },
    link: { parent?: string; title?: string } = {},
  ): Promise<string> {
    if (this.isClosing()) throw new Error('The app is closing.');
    const provider = this.provider(providerId);
    if (!(await stat(options.cwd)).isDirectory()) {
      throw new Error('A session works in a folder.');
    }
    const hosted: Hosted = {
      id: randomUUID(),
      provider: providerId,
      cwd: options.cwd,
      activeAt: Date.now(),
      archived: false,
      chosen: {
        mode: options.mode ?? 'auto',
        gateway: options.gateway ?? null,
        model: options.model ?? null,
        effort: options.effort ?? null,
        sandbox: options.sandbox ?? 'workspace-write',
      },
      state: initialSessionState(),
      seq: 0,
      runs: 1,
      shown: false,
      progress: { turns: 0, turnMs: 0 },
      titleAsked: 0,
      ...(message === undefined ? {} : { sending: true }),
      ...(link.parent === undefined ? {} : { parent: link.parent }),
      ...(link.title === undefined ? {} : { titled: link.title }),
    };
    this.sessions.set(hosted.id, hosted);
    try {
      hosted.automation = await this.automation?.bind({
        id: hosted.id,
        cwd: hosted.cwd,
        mode: hosted.chosen.mode,
        sandbox: hosted.chosen.sandbox,
      });
      this.followWaiting(hosted);
      if (this.isClosing()) throw new Error('The app is closing.');
      hosted.session = await provider.start(
        { ...options, ...(hosted.automation ? { toolset: hosted.automation.toolset } : {}) },
        this.listener(hosted, false),
      );
      if (this.isClosing()) {
        await hosted.session.close();
        throw new Error('The app is closing.');
      }
    } catch (error) {
      await hosted.automation?.close(true);
      this.sessions.delete(hosted.id);
      throw error;
    }
    hosted.sessionId = hosted.session.id;
    this.keep(hosted);
    this.report(hosted);
    if (message !== undefined) {
      try {
        await this.send(hosted.id, message.text, message.images);
      } finally {
        delete hosted.sending;
        this.report(hosted);
      }
    }
    // Once the first message is in, as Claude Code keeps a title only in a transcript it has begun.
    if (link.title !== undefined) this.giveTitle(hosted, link.title);
    return hosted.id;
  }

  // Resumes a session that is not running from its provider's history, under the same id, with these
  // settings, and resolves once the provider has it open. The settings are those its page shows, which
  // start as those it last had, yolo too, since the user chose it for the session (ADR-0006); a gateway
  // no longer set up gives way to the provider's own configuration, with its default model and effort.
  // A session's history is read first, where it has not been, so that the provider's replay of it is
  // not shown again. A session that is running is left as it is, and one being resumed is waited for.
  // It rejects when the app has no such session, or the session's folder or provider is gone or
  // refuses, and the session stays as it was.
  resume(id: string, settings: SessionSettings): Promise<void> {
    const resuming = this.resuming.get(id);
    if (resuming !== undefined) return resuming;
    const hosted = this.sessions.get(id);
    const sessionId = hosted?.sessionId;
    if (hosted === undefined || sessionId === undefined) {
      return Promise.reject(new Error('The app has no such session.'));
    }
    if (!hosted.state.closed) return Promise.resolve();
    const resumed = this.reopen(hosted, sessionId, settings).finally(() => {
      this.resuming.delete(id);
    });
    this.resuming.set(id, resumed);
    return resumed;
  }

  // Passes the user's message to the session's provider. Once the provider takes it, the session moves
  // up the list, and an archived one returns to the Sessions list.
  async send(id: string, text: string, images: MessageImage[] = []): Promise<void> {
    const session = this.session(id);
    const hostedBefore = this.sessions.get(id);
    const wasRunning = hostedBefore?.state.turnRunning === true;
    const prepared = this.turnContext(hostedBefore);
    try {
      if (prepared && session.supportsHostContext === true) {
        await session.send(text, images, prepared.context, prepared);
      } else {
        await session.send(text, images);
        prepared?.failed();
      }
    } catch (error) {
      prepared?.failed();
      if (!wasRunning) hostedBefore?.automation?.turnEnded();
      throw error;
    }
    const hosted = this.sessions.get(id);
    if (hosted === undefined) return;
    hosted.activeAt = Date.now();
    hosted.archived = false;
    this.keep(hosted);
    this.report(hosted);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  title(id: string): string | undefined {
    const hosted = this.sessions.get(id);
    return hosted && (this.titleOf(hosted) ?? hosted.summary?.title);
  }

  interrupt(id: string): Promise<void> {
    this.sessions.get(id)?.automation?.stop();
    return this.session(id).interrupt();
  }

  // Passes the user's answer to the session's provider, and records it in the session's state once
  // the provider has taken it; a question's typed answers to secrets are not recorded.
  async answerApproval(id: string, requestId: string, answer: ApprovalAnswer): Promise<void> {
    await this.session(id).answerApproval(requestId, answer);
    this.recordAnswer(id, requestId, answer);
  }

  async answerQuestion(id: string, requestId: string, answer: QuestionAnswer): Promise<void> {
    const session = this.session(id);
    const hosted = this.sessions.get(id);
    const byMessage = hosted?.state.timeline.some(
      (item) =>
        item.type === 'question' &&
        item.request.id === requestId &&
        item.request.byMessage === true,
    );
    const prepared =
      byMessage && answer.decision === 'answer' && session.supportsHostContext === true
        ? prepareContext(hosted?.automation)
        : undefined;
    const failed = () => {
      prepared?.failed();
      if (hosted && !hosted.state.turnRunning) hosted.automation?.turnEnded();
    };
    try {
      if (prepared)
        await session.answerQuestion(requestId, answer, prepared.context, {
          accepted: (delivered) => {
            prepared.accepted(delivered);
          },
          failed,
        });
      else await session.answerQuestion(requestId, answer);
    } catch (error) {
      if (prepared) failed();
      throw error;
    }
    this.recordAnswer(id, requestId, answer);
  }

  async setMode(id: string, mode: PermissionMode): Promise<void> {
    const hosted = this.sessions.get(id);
    const before = hosted && this.policy(hosted);
    if (hosted && before) hosted.automation?.setPolicy({ ...before, mode });
    try {
      await this.session(id).setMode(mode);
    } catch (error) {
      if (hosted && before) hosted.automation?.setPolicy(before);
      throw error;
    }
  }

  setGateway(id: string, gateway: string | null): Promise<void> {
    return this.session(id).setGateway(gateway);
  }

  setModel(id: string, model: string | null): Promise<void> {
    return this.session(id).setModel(model);
  }

  setEffort(id: string, effort: ReasoningEffort | null): Promise<void> {
    return this.session(id).setEffort(effort);
  }

  async setSandbox(id: string, sandbox: SandboxLevel): Promise<void> {
    const hosted = this.sessions.get(id);
    const before = hosted && this.policy(hosted);
    if (hosted && before) hosted.automation?.setPolicy({ ...before, sandbox });
    try {
      await this.session(id).setSandbox(sandbox);
    } catch (error) {
      if (hosted && before) hosted.automation?.setPolicy(before);
      throw error;
    }
  }

  // The session's state so far, or null for a session the host does not have. For a session of an
  // earlier run, the first snapshot begins reading its history, whose events follow as one event. The
  // window shows the session from then on, and the lists give it where the Sessions list does not hold
  // it, as for an archived session.
  snapshot(id: string): SessionSnapshot | null {
    const hosted = this.sessions.get(id);
    if (hosted === undefined) return null;
    void this.read(hosted);
    if (!hosted.shown) {
      hosted.shown = true;
      if (hosted.summary !== undefined && !this.listed(hosted)) this.notify();
    }
    return { seq: hosted.seq, state: hosted.state };
  }

  // Begins reading the history of a session of an earlier run, where it has not been read, ahead of
  // its first snapshot, so that its page shows it at once. The session is not shown by this.
  preload(id: string): void {
    const hosted = this.sessions.get(id);
    if (hosted !== undefined) void this.read(hosted);
  }

  // What the lists show: the sessions started in the app, in this run and earlier ones, that are not
  // archived, those the records keep and any that is open, the most recently active first; how many
  // are archived; and the others whose pages the window has shown in this run.
  list(): SessionList {
    const sessions: SessionSummary[] = [];
    const shown: SessionSummary[] = [];
    let archived = 0;
    for (const hosted of this.sessions.values()) {
      const { summary } = hosted;
      if (summary === undefined) continue;
      if (summary.archived === true) archived += 1;
      if (this.listed(hosted)) sessions.push(summary);
      else if (hosted.shown) shown.push(summary);
    }
    return { sessions: sessions.sort(byActivity), archived, shown };
  }

  // The archived sessions, the most recently active first.
  archived(): SessionSummary[] {
    return [...this.sessions.values()]
      .flatMap(({ summary }) => (summary?.archived === true ? [summary] : []))
      .sort(byActivity);
  }

  // Moves the session to the archived list, as the user asks, closing it while it is open: one that is
  // working stops.
  archive(id: string): Promise<void> {
    return this.archiveOne(id, false);
  }

  // Archives the session, and its children with it (ADR-0036). A running child the user archives on
  // its own is reported to its parent (ADR-0042); those archived with their parent are not.
  private async archiveOne(id: string, withParent: boolean): Promise<void> {
    const hosted = this.sessions.get(id);
    if (hosted === undefined || hosted.archived) return;
    if (!withParent && this.running(hosted))
      this.tellParent(hosted, 'stopped', undefined, 'archived');
    hosted.archived = true;
    this.keep(hosted);
    this.report(hosted);
    await Promise.all([
      this.close(hosted),
      ...this.childrenOf(id).map((child) => this.archiveOne(child.id, true)),
    ]);
  }

  // Returns an archived session to the Sessions list.
  unarchive(id: string): void {
    const hosted = this.sessions.get(id);
    if (hosted?.archived !== true) return;
    hosted.archived = false;
    this.keep(hosted);
    this.report(hosted);
    for (const child of this.childrenOf(id)) this.unarchive(child.id);
  }

  // Takes the session off the app's lists and out of its records, as the user asks, closing it while it
  // is open; its provider's own history keeps it.
  remove(id: string): Promise<void> {
    return this.removeOne(id, false);
  }

  // Removes the session, and its children with it (ADR-0036). A running child the user removes on its
  // own is reported to its parent (ADR-0042); those removed with their parent are not.
  private async removeOne(id: string, withParent: boolean): Promise<void> {
    const hosted = this.sessions.get(id);
    if (hosted === undefined) return;
    if (!withParent && this.running(hosted))
      this.tellParent(hosted, 'stopped', undefined, 'removed');
    const children = this.childrenOf(id);
    this.sessions.delete(id);
    this.records.remove(id);
    this.forgetText(id);
    this.inboxes.forget(id);
    this.notify(id);
    await Promise.all([
      this.close(hosted).then(() => hosted.automation?.close(true)),
      // A parent's children go with it (ADR-0036).
      ...children.map((child) => this.removeOne(child.id, true)),
    ]);
  }

  // Offers the session's menu, and does what the user chooses once they confirm where it asks:
  // archiving a session that is working, which stops it, and removing any.
  async showMenu(id: string, ui: SessionsMenuUi): Promise<SessionAction | null> {
    const shown = this.sessions.get(id)?.summary;
    if (shown === undefined) return null;
    const action = await ui.sessionMenu(shown);
    if (action === null) return null;
    return this.act(id, action, ui);
  }

  // Does to the session what its menu would, once the user confirms where the menu asks; resolves
  // with what was done, or null.
  async act(id: string, action: SessionAction, ui: SessionsMenuUi): Promise<SessionAction | null> {
    // What the list shows now, which may have changed while a menu was open.
    const summary = this.sessions.get(id)?.summary;
    if (summary === undefined) return null;
    switch (action) {
      case 'archive': {
        // A parent's children go with it, so that any of them working stops too.
        const working = [
          summary,
          ...this.childrenOf(id).flatMap((child) => child.summary ?? []),
        ].some((one) => one.status === 'running' || one.status === 'waiting');
        if (working && !(await ui.confirmArchive(summary))) return null;
        await this.archive(id);
        return action;
      }
      case 'unarchive':
        this.unarchive(id);
        return action;
      case 'remove':
        if (!(await ui.confirmRemove(summary))) return null;
        await this.remove(id);
        return action;
    }
  }

  onChange(listener: (list: SessionListChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Hears every event of every session, numbered within its session as the snapshots count them.
  onEvent(listener: SessionEventsListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  // Closes every session and its provider process, as the app does when it quits, and waits for each
  // to end as its provider reports, and for the texts their ends keep, so that quitting leaves none
  // half-written.
  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(
      [...this.sessions.values()].flatMap((hosted) =>
        hosted.automation ? [hosted.automation.close()] : [],
      ),
    );
    const open = [...this.sessions.values()].filter(
      (hosted) => hosted.session !== undefined && !hosted.state.closed,
    );
    await Promise.all(open.map((hosted) => this.closeToEnd(hosted)));
    await this.texts.settled();
  }

  // The sessions of the Sessions list, or of the archived list, whose title and conversation hold every
  // word of the query, whatever its case, each with the passage of the conversation where the first
  // word it holds appears, and how many sessions of the list have no text yet. A session read in this
  // run is searched as its state is now, others as their kept text.
  async search(query: string, archived: boolean): Promise<SessionSearch> {
    const words = searchWords(query);
    await this.textsListed;
    const listed = [...this.sessions.values()].filter(
      (hosted) =>
        hosted.summary !== undefined && (archived ? hosted.archived : this.listed(hosted)),
    );
    const matches: SessionSearch['matches'] = [];
    let unread = 0;
    const look = async (hosted: Hosted) => {
      let text: string | undefined;
      if (!hosted.state.loadingHistory) text = textOf(hosted.state);
      else if (this.stored.has(hosted.id)) text = await this.texts.read(hosted.id);
      else if (!this.unreadable.has(hosted.id)) unread += 1;
      const match = matchOf(words, hosted.summary?.title ?? '', text ?? '');
      if (match !== null) matches.push({ id: hosted.id, ...match });
    };
    for (let start = 0; start < listed.length; start += SEARCH_READS) {
      await Promise.all(listed.slice(start, start + SEARCH_READS).map(look));
    }
    return { matches, unread };
  }

  // Reads, one at a time and the most recently active first, the history of each session that has no
  // text yet, keeping its text alone, without resuming it; a session read otherwise meanwhile is
  // skipped, and one whose history cannot be read is tried again in the next run. Texts of sessions
  // the app no longer has go first. Stops as the app quits.
  async catchUp(): Promise<void> {
    await this.textsListed;
    for (const id of this.stored) {
      if (!this.sessions.has(id)) this.forgetText(id);
    }
    const waiting = [...this.sessions.values()]
      .filter((hosted) => !this.stored.has(hosted.id))
      .sort((left, right) => right.activeAt - left.activeAt);
    for (const hosted of waiting) {
      const { sessionId } = hosted;
      if (this.closing) return;
      if (sessionId === undefined || this.stored.has(hosted.id) || hosted.reading !== undefined) {
        continue;
      }
      if (this.sessions.get(hosted.id) !== hosted) continue;
      if (!hosted.state.loadingHistory) {
        this.keepText(hosted);
        continue;
      }
      try {
        const past = await this.provider(hosted.provider).history(sessionId, hosted.cwd);
        // Read otherwise, or gone, meanwhile.
        if (this.stored.has(hosted.id) || this.sessions.get(hosted.id) !== hosted) continue;
        this.stored.add(hosted.id);
        await this.texts.write(hosted.id, textOf(applyEvent(initialSessionState(), pastOf(past))));
      } catch (error) {
        this.unreadable.add(hosted.id);
        console.error('A session’s history could not be read for searching:', error);
      }
    }
  }

  private provider(providerId: ProviderId): Provider {
    const provider = this.providers.get(providerId);
    if (provider === undefined) throw new Error(`${providerId} is not available.`);
    return provider;
  }

  // The provider's session of a session that is running.
  private session(id: string): ProviderSession {
    const hosted = this.sessions.get(id);
    if (hosted?.session === undefined || hosted.state.closed) {
      throw new Error('The session is not open.');
    }
    return hosted.session;
  }

  private async close(hosted: Hosted): Promise<void> {
    hosted.closedByHost = true;
    await hosted.automation?.close();
    hosted.stopWaiting?.();
    delete hosted.stopWaiting;
    delete hosted.approvalsSince;
    if (hosted.session !== undefined && !hosted.state.closed) await hosted.session.close();
  }

  // Closes the session and waits for the closed event that follows, unless closing it fails.
  private async closeToEnd(hosted: Hosted): Promise<void> {
    const ended = new Promise<void>((resolve) => {
      this.ending.set(hosted.id, resolve);
    });
    try {
      await this.close(hosted);
    } catch {
      this.ending.delete(hosted.id);
      return;
    }
    await ended;
  }

  private async reopen(
    hosted: Hosted,
    sessionId: string,
    settings: SessionSettings,
  ): Promise<void> {
    const provider = this.provider(hosted.provider);
    if (!(await stat(hosted.cwd)).isDirectory()) {
      throw new Error('A session works in a folder.');
    }
    await this.read(hosted);
    const gatewayGone =
      settings.gateway !== null && !(await provider.listGateways()).includes(settings.gateway);
    const chosen = gatewayGone
      ? { ...settings, gateway: null, model: null, effort: null }
      : settings;
    const { mode, gateway, model, effort, sandbox } = chosen;
    hosted.runs += 1;
    delete hosted.closedByHost;
    hosted.automation = await this.automation?.bind({
      id: hosted.id,
      cwd: hosted.cwd,
      mode,
      sandbox,
    });
    this.followWaiting(hosted);
    if (this.closing || this.sessions.get(hosted.id) !== hosted) {
      await hosted.automation?.close(true);
      throw new Error('The session is no longer open.');
    }
    let session: ProviderSession;
    try {
      session = await provider.resume(
        {
          sessionId,
          cwd: hosted.cwd,
          mode,
          sandbox,
          ...(hosted.automation ? { toolset: hosted.automation.toolset } : {}),
          ...(gateway === null ? {} : { gateway }),
          ...(model === null ? {} : { model }),
          ...(effort === null ? {} : { effort }),
        },
        this.listener(hosted, true),
      );
    } catch (error) {
      hosted.automation?.disconnect();
      throw error;
    }
    // A session removed from the list while it resumed is closed again.
    if (this.sessions.get(hosted.id) !== hosted) {
      await hosted.automation?.close(true);
      void session.close();
      throw new Error('The session is no longer on the list.');
    }
    hosted.chosen = chosen;
    hosted.session = session;
    hosted.sessionId = session.id;
    this.apply(hosted, { type: 'resumed' });
  }

  // Folds a provider session's events into the session while it is the session's latest and the
  // session is on the list. A resumed session's provider replays its history first, which the state
  // holds already but where it could not be read: then the replay becomes the session's history.
  private listener(hosted: Hosted, resumed: boolean): SessionEventListener {
    const run = hosted.runs;
    const replayed: SessionEvent[] = [];
    let replaying = resumed;
    return (event) => {
      if (this.sessions.get(hosted.id) !== hosted || hosted.runs !== run) return;
      if (!replaying) {
        this.apply(hosted, event);
      } else if (event.type !== 'replay-finished') {
        replayed.push(event);
      } else {
        replaying = false;
        if (hosted.state.historyFailed) this.apply(hosted, pastOf(replayed));
      }
    };
  }

  // Reads a session of an earlier run from its provider's history, once, without resuming it; what
  // cannot be read leaves the session without history.
  private read(hosted: Hosted): Promise<void> {
    const { sessionId } = hosted;
    if (!hosted.state.loadingHistory || sessionId === undefined) return Promise.resolve();
    hosted.reading ??= this.history(hosted, sessionId);
    return hosted.reading;
  }

  private async history(hosted: Hosted, sessionId: string): Promise<void> {
    let past: SessionEvent;
    try {
      past = pastOf(await this.provider(hosted.provider).history(sessionId, hosted.cwd));
    } catch (error) {
      console.error('A session’s history could not be read:', error);
      past = { type: 'history', events: [], failed: true };
    }
    if (this.sessions.get(hosted.id) === hosted) this.apply(hosted, past);
  }

  private recordAnswer(
    id: string,
    requestId: string,
    answer: ApprovalAnswer | QuestionAnswer,
  ): void {
    const hosted = this.sessions.get(id);
    if (hosted === undefined) return;
    const asked = hosted.state.timeline.find(
      (item) => item.type === 'question' && item.request.id === requestId,
    );
    this.apply(hosted, {
      type: 'request-answered',
      requestId,
      answer: asked?.type === 'question' ? withoutSecrets(asked.request, answer) : answer,
    });
  }

  // A session moves up the list as a turn of it ends.
  private apply(hosted: Hosted, event: SessionEvent): void {
    hosted.state = applyEvent(hosted.state, event);
    if (event.type === 'turn-started') hosted.automation?.turnStarted();
    if (event.type === 'turn-ended') hosted.automation?.turnEnded();
    if (event.type === 'mode' || event.type === 'settings')
      hosted.automation?.setPolicy(this.policy(hosted));
    if (event.type === 'settings' || event.type === 'models') this.knowEffort(hosted);
    if (event.type === 'closed') hosted.automation?.disconnect();
    hosted.seq += 1;
    if (event.type === 'turn-started') hosted.turnSince ??= Date.now();
    if (event.type === 'turn-ended') {
      hosted.activeAt = Date.now();
      hosted.progress = {
        turns: hosted.progress.turns + 1,
        turnMs: hosted.progress.turnMs + (Date.now() - (hosted.turnSince ?? Date.now())),
      };
      delete hosted.turnSince;
    }
    for (const listener of this.eventListeners) listener(hosted.id, hosted.seq, event);
    this.keep(hosted);
    this.report(hosted);
    if (TEXT_EVENTS.has(event.type)) this.keepText(hosted);
    if (event.type === 'turn-ended') {
      this.writeTitle(hosted);
      // Once the adapter has finished reporting the turn's end.
      queueMicrotask(() => {
        this.wake(hosted);
      });
    }
    if (event.type === 'closed') {
      this.ending.get(hosted.id)?.();
      this.ending.delete(hosted.id);
    }
    // What a child's parent hears of the child's turn's end or its close (ADR-0042), unless the host
    // closes the child itself.
    if (hosted.closedByHost !== true) {
      if (event.type === 'turn-ended' && event.outcome !== 'completed') {
        this.tellParent(hosted, event.outcome, event.error);
      }
      if (event.type === 'closed') this.tellParent(hosted, 'stopped', event.error);
    }
  }

  // Puts the app's report on a child into its parent's inbox and tells the parent of it as of a message
  // (ADR-0042): a turn that ended in an error or that the user interrupted, or the child stopping on
  // its own or as the user archived or removed it. Nothing for a session that is not a child, for a
  // parent the app no longer has, or as the app quits.
  private tellParent(
    child: Hosted,
    report: InboxReport,
    reason: string | undefined,
    byUser?: 'archived' | 'removed',
  ): void {
    if (child.parent === undefined || this.closing) return;
    const parent = this.sessions.get(child.parent);
    if (parent === undefined) return;
    const title = this.titleOf(child) ?? child.provider;
    const full = reason?.trim() ?? '';
    const summary = reportSummary(report, title, full.replace(/\s+/g, ' '), byUser);
    this.inboxes.send({
      from: child.id,
      fromTitle: title,
      to: parent.id,
      summary: clipped(summary, MESSAGE_LIMITS.summary),
      body: clippedBytes(full === '' ? summary : full, MESSAGE_LIMITS.bodyBytes),
      sentAt: Date.now(),
      report,
    });
    this.wake(parent);
  }

  private isClosing(): boolean {
    return this.closing;
  }

  // Sets the starting effort for a running session whose model takes an effort but which has none
  // whose provider names the model's default, as Claude Code names none, so that it runs with an
  // effort its page can show as one of the model's levels: after a start before the models were
  // known, a switch from a model that takes no effort, or a resumption without one. Once for each
  // model and effort, so that a refusal is not asked again.
  private knowEffort(hosted: Hosted): void {
    const { session, state } = hosted;
    if (session === undefined || state.closed) return;
    const model = modelInUse(state.models, state.model);
    const level = effortToSet(model, state.effort);
    if (level === null || model === undefined) return;
    const asked = `${model.id}\n${state.effort ?? ''}`;
    if (hosted.effortSet === asked) return;
    hosted.effortSet = asked;
    // Once the event that called for it has been folded and heard.
    queueMicrotask(() => {
      session.setEffort(level).catch((error: unknown) => {
        console.error('A session’s reasoning effort could not be set:', error);
      });
    });
  }

  private policy(hosted: Hosted): { mode: PermissionMode; sandbox: SandboxLevel } {
    return {
      mode: hosted.state.mode ?? hosted.chosen.mode,
      sandbox: hosted.state.sandbox ?? hosted.chosen.sandbox,
    };
  }

  // What the toolset's session tools reach of the sessions (ADR-0036), for the session each call
  // names by its own id.
  coordinator(): SessionCoordinator {
    return {
      mayStart: (owner) => {
        const hosted = this.sessions.get(owner);
        return hosted !== undefined && hosted.parent === undefined;
      },
      list: (owner) => {
        this.caller(owner);
        return this.list().sessions.map(coordinated);
      },
      providers: (owner) => this.childModels(owner),
      start: (owner, request) => this.startChild(owner, request),
      end: (owner, id) => this.endChild(owner, id),
      send: (owner, to, summary, body) => this.sendMessage(owner, to, summary, body),
      inbox: (owner) => {
        this.caller(owner);
        return this.inboxes.list(owner).map(entryOf);
      },
      read: (owner, id) => {
        this.caller(owner);
        const message = this.inboxes.read(owner, id);
        if (message === undefined) throw new Error('Your inbox has no message with that id.');
        return { ...entryOf(message), body: message.body };
      },
      notices: (owner) => {
        const hosted = this.sessions.get(owner);
        if (hosted === undefined) return undefined;
        const notices = this.untold(hosted);
        return notices.length === 0
          ? undefined
          : {
              notices,
              told: () => {
                this.told(hosted, notices);
              },
            };
      },
    };
  }

  // The calling session, which must be one the app has.
  private caller(owner: string): Hosted {
    const hosted = this.sessions.get(owner);
    if (hosted === undefined) throw new Error('The app does not know the calling session.');
    return hosted;
  }

  // The session's children, those that are archived included.
  private childrenOf(id: string): Hosted[] {
    return [...this.sessions.values()].filter((hosted) => hosted.parent === id);
  }

  // The models each provider offers a child of the session (ADR-0041), or why it could not list them.
  private async childModels(owner: string): Promise<ChildModels[]> {
    const parent = this.caller(owner);
    if (parent.parent !== undefined) throw new Error('A child session cannot start sessions.');
    return Promise.all(
      this.providerIds().map(async (provider): Promise<ChildModels> => {
        try {
          return { provider, models: await this.childList(parent, provider) };
        } catch (error) {
          return { provider, problem: problemOf(error) };
        }
      }),
    );
  }

  // The models a child of the session on the provider could use, for the session's folder: through
  // the session's gateway on its own provider, and through the provider's own configuration on
  // another, as the child would start. A list found within the last 15 seconds or a new one, as the
  // new-session page asks for before its first message.
  private childList(parent: Hosted, provider: ProviderId): Promise<ModelOption[]> {
    const gateway = provider === parent.provider ? this.settingsOf(parent).gateway : null;
    return this.models(provider, gateway, parent.cwd, true);
  }

  // Refuses a child a model its provider does not list, or an effort the model it will run does not
  // take (ADR-0041), naming what to use instead: the model the child runs is the one named, otherwise
  // the parent's where the child has the parent's provider, otherwise the provider's default (null
  // for those two). A model or effort left out is not checked, and a list that cannot be had, or that
  // holds no model, leaves the choice to the provider.
  private async checkChoice(
    parent: Hosted,
    provider: ProviderId,
    request: ChildRequest,
    model: string | null,
  ): Promise<void> {
    if (request.model === undefined && request.effort === undefined) return;
    const listed = await this.childList(parent, provider).catch(() => []);
    if (listed.length === 0) return;
    if (request.model !== undefined && !listed.some((option) => option.id === request.model)) {
      const holders = await this.holdersOf(parent, provider, request.model);
      throw new Error(
        `${provider} offers no model ${request.model}. Its models: ${listed.map((option) => option.id).join(', ')}.${
          holders.length === 0
            ? ''
            : ` ${holders.join(', ')} ${holders.length === 1 ? 'offers' : 'offer'} ${request.model}.`
        }`,
      );
    }
    if (request.effort === undefined) return;
    const runs = listed.find((option) =>
      model === null ? option.default === true : option.id === model,
    );
    if (runs === undefined || runs.efforts.includes(request.effort)) return;
    throw new Error(
      runs.efforts.length === 0
        ? `${runs.id} takes no reasoning effort level.`
        : `${runs.id} takes no reasoning effort ${request.effort}. Its levels: ${runs.efforts.join(', ')}.`,
    );
  }

  // The providers other than the one given whose models for a child of the session include the
  // model, those that cannot list theirs aside.
  private async holdersOf(
    parent: Hosted,
    except: ProviderId,
    model: string,
  ): Promise<ProviderId[]> {
    const others = this.providerIds().filter((provider) => provider !== except);
    const holds = await Promise.all(
      others.map((provider) =>
        this.childList(parent, provider).then(
          (listed) => listed.some((option) => option.id === model),
          () => false,
        ),
      ),
    );
    return others.filter((_, index) => holds[index] === true);
  }

  // Starts a child of a running session that is not a child itself (ADR-0036), in its folder, in
  // auto, at its sandbox level or a narrower one, with its provider, gateway, model and effort
  // unless the request names others, once fewer than eight of its children run, and once its
  // provider's list allows the model and effort named (ADR-0041).
  private async startChild(owner: string, request: ChildRequest): Promise<CoordinatedSession> {
    const parent = this.caller(owner);
    if (parent.parent !== undefined) throw new Error('A child session cannot start sessions.');
    if (parent.session === undefined || parent.state.closed) {
      throw new Error('The calling session is not running.');
    }
    const running = this.childrenOf(owner).filter(
      (child) => child.session !== undefined && !child.state.closed,
    );
    const starting = this.childStarts.get(owner) ?? 0;
    if (running.length + starting >= CHILD_LIMIT) {
      throw new Error(
        `A session can have at most ${String(CHILD_LIMIT)} children running at once; end one first.`,
      );
    }
    const prompt = request.prompt.trim();
    if (prompt === '') throw new Error('A child needs a first message that says its task.');
    const own = this.settingsOf(parent);
    const sandbox = request.sandbox ?? own.sandbox;
    if (SANDBOX_ORDER.indexOf(sandbox) > SANDBOX_ORDER.indexOf(own.sandbox)) {
      throw new Error(`A child cannot have a wider sandbox than its parent’s, ${own.sandbox}.`);
    }
    const providerId = request.provider ?? parent.provider;
    const same = providerId === parent.provider;
    const gateway = same ? own.gateway : null;
    const model = request.model ?? (same ? own.model : null);
    const effort = request.effort ?? (same && model === own.model ? own.effort : null);
    const title = request.title === undefined ? undefined : cleanTitle(request.title);
    // Counted among the children starting from here on, so that the limit holds while the provider's
    // list is found.
    this.childStarts.set(owner, starting + 1);
    let id: string;
    try {
      await this.checkChoice(parent, providerId, request, model);
      id = await this.start(
        providerId,
        {
          cwd: parent.cwd,
          mode: 'auto',
          sandbox,
          ...(gateway === null ? {} : { gateway }),
          ...(model === null ? {} : { model }),
          ...(effort === null ? {} : { effort }),
        },
        { text: prompt },
        { parent: owner, ...(title === undefined ? {} : { title }) },
      );
    } finally {
      const left = (this.childStarts.get(owner) ?? 1) - 1;
      if (left > 0) this.childStarts.set(owner, left);
      else this.childStarts.delete(owner);
    }
    const summary = this.sessions.get(id)?.summary;
    if (summary === undefined) throw new Error('The child left the list as it started.');
    return coordinated(summary);
  }

  // Ends a child of the calling session, or the calling session where it is a child: it closes and
  // stays in the list, closed. A child that ends itself closes a moment later, once its call's
  // result has reached it.
  private async endChild(owner: string, id: string): Promise<CoordinatedSession> {
    const caller = this.caller(owner);
    const target = this.sessions.get(id);
    const own = id === owner ? caller.parent !== undefined : target?.parent === owner;
    if (target === undefined || !own) {
      throw new Error('A session can end only the children it started, and a child itself.');
    }
    if (id === owner) {
      setTimeout(() => {
        this.close(target).catch(reportClose);
      }, SELF_END_MS);
    } else {
      await this.close(target);
    }
    const summary = target.summary;
    if (summary === undefined) throw new Error('The session is not listed.');
    return coordinated(summary);
  }

  // Puts a message in another session's inbox, one of the Sessions list's, and tells that session
  // at once where it is idle.
  private sendMessage(
    owner: string,
    to: string,
    summary: string,
    body: string,
  ): InboxEntry & { to: string; toTitle: string } {
    const sender = this.caller(owner);
    if (to === owner) throw new Error('A session cannot send a message to itself.');
    const target = this.sessions.get(to);
    if (target === undefined || !this.listed(target)) {
      throw new Error('The Sessions list holds no session with that id.');
    }
    const said = summary.replace(/\s+/g, ' ').trim();
    if (said === '' || said.length > MESSAGE_LIMITS.summary) {
      throw new Error(
        `A message needs a summary of 1 to ${String(MESSAGE_LIMITS.summary)} characters.`,
      );
    }
    if (Buffer.byteLength(body, 'utf8') > MESSAGE_LIMITS.bodyBytes) {
      throw new Error(`A message’s body holds at most ${String(MESSAGE_LIMITS.bodyBytes)} bytes.`);
    }
    const message = this.inboxes.send({
      from: owner,
      fromTitle: this.titleOf(sender) ?? sender.provider,
      to,
      summary: said,
      body,
      sentAt: Date.now(),
    });
    this.wake(target);
    return { ...entryOf(message), to, toTitle: this.titleOf(target) ?? target.provider };
  }

  // The session's messages its agent has not been told of, as a notice names them.
  private untold(hosted: Hosted): InboxNotice[] {
    return this.inboxes.untold(hosted.id).map(noticeOf);
  }

  // Marks notices told, and shows them in the session's activity.
  private told(hosted: Hosted, notices: readonly InboxNotice[]): void {
    this.inboxes.told(
      hosted.id,
      notices.map((notice) => notice.id),
    );
    if (this.sessions.get(hosted.id) === hosted) {
      this.apply(hosted, { type: 'inbox', notices: [...notices] });
    }
  }

  // The context a message carries beside the user's text: the automation's notices and the notices
  // of new messages, with what tells each of its delivery.
  private turnContext(
    hosted: Hosted | undefined,
  ): (HostContextDelivery & { context: HostTurnContext }) | undefined {
    const prepared = prepareContext(hosted?.automation);
    const notices = hosted === undefined ? [] : this.untold(hosted);
    if (hosted === undefined || notices.length === 0) return prepared;
    return {
      context: {
        presentationNotices: prepared?.context.presentationNotices ?? [],
        inboxNotices: notices,
      },
      accepted: (delivered) => {
        prepared?.accepted(delivered);
        this.told(hosted, notices);
      },
      failed: () => {
        prepared?.failed();
      },
    };
  }

  // Tells an idle session of its new messages in a turn of the app's own (ADR-0036): one running,
  // with no turn, no request waiting on the user and no first message on its way, whose provider
  // takes host context alone. One at a time; what is not taken waits for the next fitting moment.
  private wake(hosted: Hosted): void {
    const { session, state } = hosted;
    if (session?.deliverContext === undefined || session.supportsHostContext !== true) return;
    if (this.sessions.get(hosted.id) !== hosted || state.closed || state.turnRunning) return;
    if (hosted.sending === true || hosted.waking === true || openRequests(state).length > 0) return;
    if (this.inboxes.untold(hosted.id).length === 0) return;
    const prepared = this.turnContext(hosted);
    if (prepared?.context.inboxNotices === undefined) {
      prepared?.failed();
      return;
    }
    hosted.waking = true;
    session.deliverContext(prepared.context, prepared).then(
      () => {
        delete hosted.waking;
      },
      (error: unknown) => {
        delete hosted.waking;
        prepared.failed();
        hosted.automation?.turnEnded();
        console.error('A session could not be told of its new messages:', error);
      },
    );
  }

  // The settings the session has: those it reported, or else those it started or resumed with.
  private settingsOf(hosted: Hosted): SessionSettings {
    const { state, chosen } = hosted;
    return {
      mode: state.mode ?? chosen.mode,
      gateway: state.gateway === undefined ? chosen.gateway : state.gateway,
      model: state.model === undefined ? chosen.model : state.model,
      effort: state.effort === undefined ? chosen.effort : state.effort,
      sandbox: state.sandbox ?? chosen.sandbox,
    };
  }

  // Asks the session's provider for a title once the session has run for a while, where the
  // provider has given it none of its own (ADR-0037): with the model the session runs and its title
  // effort, through its gateway, from the conversation so far, beside the session, which goes on
  // meanwhile. A session already titled, by the provider on its own, as Claude Code and Grok Build
  // title theirs, by the user in the provider's tools, or by the app, and one asked for three times
  // are left as they are. The title replaces the first message, is kept with the session and given
  // back to the provider; a request that fails or gives nothing usable is tried again at the end of
  // the next turn, and a title that comes once the session has closed or left the lists, or once
  // the provider has titled it, is dropped.
  private writeTitle(hosted: Hosted): void {
    const provider = this.providers.get(hosted.provider);
    const { state } = hosted;
    if (provider?.writeTitle === undefined || hosted.session === undefined || state.closed) return;
    if (hosted.titled !== undefined || hosted.titling === true) return;
    if (hosted.titleAsked >= TITLE_ATTEMPTS || !ranAWhile(hosted.progress)) return;
    if (state.title !== undefined) return;
    const prompt = titlePrompt(state);
    if (prompt === undefined) return;
    const model = state.model === undefined ? hosted.chosen.model : state.model;
    const request = {
      gateway: state.gateway === undefined ? hosted.chosen.gateway : state.gateway,
      model,
      effort: titleEffort(modelInUse(state.models, model)),
      prompt,
    };
    hosted.titleAsked += 1;
    hosted.titling = true;
    provider
      .writeTitle(request)
      .then(cleanTitle, (error: unknown) => {
        console.error('A session’s title could not be written:', error);
        return undefined;
      })
      .then((title) => {
        delete hosted.titling;
        const live = this.sessions.get(hosted.id) === hosted && !hosted.state.closed;
        if (title === undefined || !live || hosted.state.title !== undefined) return;
        hosted.titled = title;
        this.keep(hosted);
        this.report(hosted);
        this.giveTitle(hosted, title);
      }, reportTitle);
  }

  // Gives the session's provider the title written for it, where the provider keeps titles.
  private giveTitle(hosted: Hosted, title: string): void {
    hosted.session?.setTitle?.(title).catch((error: unknown) => {
      console.error('A session’s title could not be given to its provider:', error);
    });
  }

  // The title the lists show: the one the provider keeps for the session, its own, the user's or the
  // app's as the provider took it, then the one the app wrote for it, then its first message.
  private titleOf(hosted: Hosted): string | undefined {
    const { state, titled } = hosted;
    return state.title ?? titled ?? firstPrompt(state);
  }

  // Keeps the text of the session's messages as they are now, once the provider has started it and
  // its history, if any, has been read.
  private keepText(hosted: Hosted): void {
    if (hosted.sessionId === undefined || hosted.state.loadingHistory) return;
    this.stored.add(hosted.id);
    this.unreadable.delete(hosted.id);
    this.texts.write(hosted.id, textOf(hosted.state)).catch(reportText);
  }

  private forgetText(id: string): void {
    this.stored.delete(id);
    this.unreadable.delete(id);
    this.texts.remove(id).catch(reportText);
  }

  // Keeps what a later run needs to list the session, show its history and resume it as it is now,
  // once the provider has started it: its title as the list shows it, its latest activity, whether it
  // is archived, how much of its context window it took when the provider last said, and the settings
  // it has, saved when they change.
  private keep(hosted: Hosted): void {
    const { sessionId, state, chosen } = hosted;
    if (sessionId === undefined) return;
    const before = this.records.get(hosted.id);
    const title = this.titleOf(hosted) ?? before?.title;
    const context = state.context ?? before?.context;
    const record: SessionRecord = {
      id: hosted.id,
      provider: hosted.provider,
      sessionId,
      cwd: hosted.cwd,
      ...(title === undefined ? {} : { title }),
      ...(hosted.titled === undefined ? {} : { titled: hosted.titled }),
      ...(hosted.parent === undefined ? {} : { parent: hosted.parent }),
      activeAt: hosted.activeAt,
      ...(hosted.archived ? { archived: true } : {}),
      ...(context === undefined ? {} : { context }),
      mode: state.mode ?? chosen.mode,
      gateway: state.gateway === undefined ? chosen.gateway : state.gateway,
      model: state.model === undefined ? chosen.model : state.model,
      effort: state.effort === undefined ? chosen.effort : state.effort,
      sandbox: state.sandbox ?? chosen.sandbox,
    };
    if (before === undefined || !sameFields(before, record)) this.records.keep(record);
  }

  // Tells the listeners when what the lists show has changed: a change to a session that was archived
  // and stays so changes nothing there, unless the window has shown it.
  private report(hosted: Hosted): void {
    if (hosted.sessionId === undefined) return;
    if (hosted.sending === true && firstPrompt(hosted.state) === undefined) return;
    const summary = this.summaryOf(hosted, hosted.sessionId);
    const before = hosted.summary;
    if (before !== undefined && sameFields(before, summary)) return;
    hosted.summary = summary;
    if (before?.archived !== true || summary.archived !== true || hosted.shown) this.notify();
  }

  private notify(removedId?: string): void {
    const list: SessionListChange = this.list();
    if (removedId !== undefined) list.removedId = removedId;
    for (const listener of this.listeners) listener(list);
  }

  // Follows whether the session's automation waits for the user's answer to an operation's approval,
  // which the lists show as the session waiting, as a provider's own request does. A newer binding
  // replaces the one before it.
  private followWaiting(hosted: Hosted): void {
    hosted.stopWaiting?.();
    delete hosted.approvalsSince;
    const automation = hosted.automation;
    if (automation === undefined) {
      delete hosted.stopWaiting;
      return;
    }
    hosted.stopWaiting = automation.onWaiting((since) => {
      if (hosted.automation !== automation) return;
      if (since === undefined) delete hosted.approvalsSince;
      else hosted.approvalsSince = since;
      this.report(hosted);
    });
  }

  // Whether the Sessions list holds the session: one that is not archived, while the records keep it
  // or it is open, so that beyond the sessions running it holds no more than the 1,000 the records
  // keep.
  private listed(hosted: Hosted): boolean {
    if (hosted.archived) return false;
    if (this.records.get(hosted.id) !== undefined) return true;
    return this.running(hosted);
  }

  // Whether the session's provider runs it now.
  private running(hosted: Hosted): boolean {
    return hosted.session !== undefined && !hosted.state.closed;
  }

  // What the lists show of the session. Until the provider titles a session, its first message stands
  // in for the title, and until the history of a session of an earlier run is read, the title the
  // records kept.
  private summaryOf(hosted: Hosted, sessionId: string): SessionSummary {
    const title = this.titleOf(hosted) ?? this.records.get(hosted.id)?.title;
    const own = sessionStatus(hosted.state);
    const asked = own === 'waiting' ? openRequests(hosted.state)[0]?.requestedAt : undefined;
    const approved = own === 'closed' ? undefined : hosted.approvalsSince;
    const status = approved === undefined ? own : 'waiting';
    const waitingSince =
      asked === undefined || approved === undefined
        ? (asked ?? approved)
        : Math.min(asked, approved);
    return {
      id: hosted.id,
      provider: hosted.provider,
      sessionId,
      cwd: hosted.cwd,
      ...(title === undefined ? {} : { title }),
      status,
      activeAt: hosted.activeAt,
      ...(waitingSince === undefined ? {} : { waitingSince }),
      ...(hosted.archived ? { archived: true } : {}),
      ...(hosted.parent === undefined ? {} : { parent: hosted.parent }),
    };
  }
}

// Supplemental host context cannot make the user's message or typed answer unavailable.
function prepareContext(automation?: SessionAutomation) {
  try {
    return automation?.prepareSend();
  } catch {
    return undefined;
  }
}

// The promise's value, or a rejection with the message once ms have passed without one.
function withinTime<Value>(promise: Promise<Value>, ms: number, message: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([promise, late]).finally(() => {
    clearTimeout(timer);
  });
}

// A session of an earlier run, not running, with the settings it last had and the context it last
// took, which only the provider's process counts. Its history is read from its provider when it is
// first shown.
function pastSession(record: SessionRecord): Hosted {
  const { mode, gateway, model, effort, sandbox, context } = record;
  return {
    id: record.id,
    provider: record.provider,
    cwd: record.cwd,
    sessionId: record.sessionId,
    activeAt: record.activeAt,
    archived: record.archived === true,
    chosen: { mode, gateway, model, effort, sandbox },
    ...(record.titled === undefined ? {} : { titled: record.titled }),
    ...(record.parent === undefined ? {} : { parent: record.parent }),
    progress: { turns: 0, turnMs: 0 },
    titleAsked: 0,
    state: {
      ...initialSessionState(true),
      closed: true,
      mode,
      gateway,
      model,
      effort,
      sandbox,
      ...(context === undefined ? {} : { context }),
    },
    seq: 0,
    runs: 0,
    shown: false,
  };
}

// The most recently active first.
function byActivity(left: SessionSummary, right: SessionSummary): number {
  return right.activeAt - left.activeAt;
}

// A session's past events as the history the host shows.
function pastOf(events: SessionEvent[]): SessionEvent {
  return { type: 'history', events: events.filter((event) => !UNSHOWN_PAST.has(event.type)) };
}

function sameFields<Value extends object>(left: Value, right: Value): boolean {
  const fields = Object.keys({ ...left, ...right }) as (keyof Value)[];
  return fields.every((field) => left[field] === right[field]);
}

// The session's first message on one line, shortened to a title's length, or nothing before it.
function firstPrompt(state: SessionState): string | undefined {
  for (const item of state.timeline) {
    if (item.type !== 'message' || item.role !== 'user') continue;
    const line = item.text.replace(/\s+/g, ' ').trim();
    if (line === '') continue;
    return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
  }
  return undefined;
}

// An answer to questions without what the user typed for those that ask for a secret.
function withoutSecrets(
  request: QuestionRequest,
  answer: ApprovalAnswer | QuestionAnswer,
): ApprovalAnswer | QuestionAnswer {
  if (answer.decision !== 'answer') return answer;
  const secret = new Set(
    request.questions.flatMap((question) => (question.secret ? [question.id] : [])),
  );
  return {
    decision: 'answer',
    answers: Object.fromEntries(
      Object.entries(answer.answers).map(([id, given]) => [
        id,
        secret.has(id) ? { selected: given.selected } : given,
      ]),
    ),
  };
}

// A session as the session tools list it.
function coordinated(summary: SessionSummary): CoordinatedSession {
  return {
    id: summary.id,
    title: summary.title ?? '',
    provider: summary.provider,
    folder: summary.cwd,
    status: summary.status,
    ...(summary.parent === undefined ? {} : { parent: summary.parent }),
  };
}

// Why a provider could not list its models, in its own words where it gives them.
function problemOf(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : 'It could not list its models.';
}

// A report's summary (ADR-0042): which child, what happened and, where the provider gave one, why.
function reportSummary(
  report: InboxReport,
  title: string,
  reason: string,
  byUser?: 'archived' | 'removed',
): string {
  const why = reason === '' ? '.' : `: ${reason}`;
  switch (report) {
    case 'failed':
      return `A turn of your child session “${title}” ended in an error${why}`;
    case 'interrupted':
      return `The user interrupted a turn of your child session “${title}”, which waits until you or the user write to it.`;
    case 'stopped':
      return byUser === undefined
        ? `Your child session “${title}” stopped: its provider’s process ended${why}`
        : `The user ${byUser} your child session “${title}”, which stopped it.`;
  }
}

// The text cut to a length in characters, an ellipsis ending it where it is cut.
function clipped(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`;
}

// The text cut to a size in UTF-8 bytes, between characters, an ellipsis ending it where it is cut.
function clippedBytes(text: string, bytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= bytes) return text;
  const ellipsis = '…';
  let size = Buffer.byteLength(ellipsis, 'utf8');
  let kept = '';
  for (const character of text) {
    size += Buffer.byteLength(character, 'utf8');
    if (size > bytes) break;
    kept += character;
  }
  return kept + ellipsis;
}

function noticeOf({ id, from, fromTitle, summary, sentAt, report }: InboxMessage): InboxNotice {
  return { id, from, fromTitle, summary, sentAt, ...(report === undefined ? {} : { report }) };
}

function entryOf(message: InboxMessage): InboxEntry {
  return { ...noticeOf(message), read: message.readAt !== undefined };
}

function reportClose(error: unknown): void {
  console.error('A session could not be closed:', error);
}

function reportTitle(error: unknown): void {
  console.error('A session’s title could not be kept:', error);
}

function reportText(error: unknown): void {
  console.error('A session’s text could not be kept or read for searching:', error);
}
