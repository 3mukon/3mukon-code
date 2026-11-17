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
  SessionSearch,
  SessionSettings,
  SessionSnapshot,
  SessionSummary,
} from '../shared/sessions';
import type {
  Provider,
  ProviderSession,
  SessionAutomation,
  SessionAutomationHost,
  SessionEventListener,
  StartOptions,
} from './provider';
import type { SessionRecord, SessionRecords } from './records';
import { searchWords } from '../shared/search';
import { matchOf, memoryTextStorage, textOf, type TextStorage } from './texts';

// How long a provider has to list its models before the list fails.
const MODELS_TIMEOUT_MS = 60_000;

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
  // then on.
  sessionId?: string;
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
  private readonly listeners = new Set<(list: SessionList) => void>();
  private readonly eventListeners = new Set<SessionEventsListener>();
  // The models each provider and gateway offer, found once per run of the app.
  private readonly modelLists = new Map<string, Promise<ModelOption[]>>();
  // The text of each session's messages, which a search by conversation reads (ADR-0014): the
  // sessions that have one, once listed, and those whose history could not be read in this run.
  private readonly texts: TextStorage;
  private readonly stored = new Set<string>();
  private readonly textsListed: Promise<void>;
  private readonly unreadable = new Set<string>();
  // Set as the app quits, which stops the catch-up.
  private closing = false;
  // What each session closing as the app quits calls as it ends, by session.
  private readonly ending = new Map<string, () => void>();

  constructor(
    providers: readonly Provider[],
    records: SessionRecords,
    texts: TextStorage = memoryTextStorage(),
    private readonly automation?: SessionAutomationHost,
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

  // Found without starting a session, and kept for the rest of the app's run once found. A list that
  // fails, or that the provider has not found within a minute, is asked for again next time.
  models(providerId: ProviderId, gateway: string | null): Promise<ModelOption[]> {
    const provider = this.provider(providerId);
    const key = `${providerId}\n${gateway ?? ''}`;
    let models = this.modelLists.get(key);
    if (models === undefined) {
      models = withinTime(
        provider.listModels(gateway),
        MODELS_TIMEOUT_MS,
        `${providerId} did not list its models in time.`,
      );
      this.modelLists.set(key, models);
      models.catch(() => {
        this.modelLists.delete(key);
      });
    }
    return models;
  }

  // Starts a session in a folder and resolves with the app's id for it once the provider has started
  // it. It rejects when the folder is not one, or the provider is not available or refuses.
  async start(providerId: ProviderId, options: StartOptions): Promise<string> {
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
    };
    this.sessions.set(hosted.id, hosted);
    try {
      hosted.automation = await this.automation?.bind({
        id: hosted.id,
        cwd: hosted.cwd,
        mode: hosted.chosen.mode,
        sandbox: hosted.chosen.sandbox,
      });
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
    const prepared = prepareContext(hostedBefore?.automation);
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

  // Moves the session to the archived list, closing it while it is open: one that is working stops.
  async archive(id: string): Promise<void> {
    const hosted = this.sessions.get(id);
    if (hosted === undefined || hosted.archived) return;
    hosted.archived = true;
    this.keep(hosted);
    this.report(hosted);
    await this.close(hosted);
  }

  // Returns an archived session to the Sessions list.
  unarchive(id: string): void {
    const hosted = this.sessions.get(id);
    if (hosted?.archived !== true) return;
    hosted.archived = false;
    this.keep(hosted);
    this.report(hosted);
  }

  // Takes the session off the app's lists and out of its records, closing it while it is open; its
  // provider's own history keeps it.
  async remove(id: string): Promise<void> {
    const hosted = this.sessions.get(id);
    if (hosted === undefined) return;
    this.sessions.delete(id);
    this.records.remove(id);
    this.forgetText(id);
    this.notify();
    await this.close(hosted);
    await hosted.automation?.close(true);
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
        const working = summary.status === 'running' || summary.status === 'waiting';
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

  onChange(listener: (list: SessionList) => void): () => void {
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
    await hosted.automation?.close();
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
    hosted.automation = await this.automation?.bind({
      id: hosted.id,
      cwd: hosted.cwd,
      mode,
      sandbox,
    });
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
    if (event.type === 'closed') hosted.automation?.disconnect();
    hosted.seq += 1;
    if (event.type === 'turn-ended') hosted.activeAt = Date.now();
    for (const listener of this.eventListeners) listener(hosted.id, hosted.seq, event);
    this.keep(hosted);
    this.report(hosted);
    if (TEXT_EVENTS.has(event.type)) this.keepText(hosted);
    if (event.type === 'closed') {
      this.ending.get(hosted.id)?.();
      this.ending.delete(hosted.id);
    }
  }

  private isClosing(): boolean {
    return this.closing;
  }

  private policy(hosted: Hosted): { mode: PermissionMode; sandbox: SandboxLevel } {
    return {
      mode: hosted.state.mode ?? hosted.chosen.mode,
      sandbox: hosted.state.sandbox ?? hosted.chosen.sandbox,
    };
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
    const title = titleOf(state) ?? before?.title;
    const context = state.context ?? before?.context;
    const record: SessionRecord = {
      id: hosted.id,
      provider: hosted.provider,
      sessionId,
      cwd: hosted.cwd,
      ...(title === undefined ? {} : { title }),
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
    const summary = this.summaryOf(hosted, hosted.sessionId);
    const before = hosted.summary;
    if (before !== undefined && sameFields(before, summary)) return;
    hosted.summary = summary;
    if (before?.archived !== true || summary.archived !== true || hosted.shown) this.notify();
  }

  private notify(): void {
    const list = this.list();
    for (const listener of this.listeners) listener(list);
  }

  // Whether the Sessions list holds the session: one that is not archived, while the records keep it
  // or it is open, so that beyond the sessions running it holds no more than the 1,000 the records
  // keep.
  private listed(hosted: Hosted): boolean {
    if (hosted.archived) return false;
    if (this.records.get(hosted.id) !== undefined) return true;
    return hosted.session !== undefined && !hosted.state.closed;
  }

  // What the lists show of the session. Until the provider titles a session, its first message stands
  // in for the title, and until the history of a session of an earlier run is read, the title the
  // records kept.
  private summaryOf(hosted: Hosted, sessionId: string): SessionSummary {
    const title = titleOf(hosted.state) ?? this.records.get(hosted.id)?.title;
    const status = sessionStatus(hosted.state);
    const waitingSince =
      status === 'waiting' ? openRequests(hosted.state)[0]?.requestedAt : undefined;
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

// The title the provider keeps for the session, or else its first message, as the list shows it.
function titleOf(state: SessionState): string | undefined {
  return state.title ?? firstPrompt(state);
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

function reportText(error: unknown): void {
  console.error('A session’s text could not be kept or read for searching:', error);
}
