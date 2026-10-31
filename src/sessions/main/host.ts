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
import type { SessionEventsListener, SessionSnapshot, SessionSummary } from '../shared/sessions';
import type { Provider, ProviderSession, StartOptions } from './provider';

// How long a provider has to list its models before the list fails.
const MODELS_TIMEOUT_MS = 60_000;

interface Hosted {
  id: string;
  provider: ProviderId;
  cwd: string;
  openedAt: number;
  // Folded from every event of the session, from the first.
  state: SessionState;
  // How many events have been folded.
  seq: number;
  // Set once the provider has started the session, which is listed from then on.
  session?: ProviderSession;
  // What the list last reported of the session.
  summary?: SessionSummary;
}

// The app's open sessions, which run in the main process through the providers' adapters. Each one's
// state is folded from its events as they arrive. Listeners hear whenever a session joins the list or
// its title or status changes, and event listeners hear every event; a closed session stays on the
// list as closed.
export class SessionHost {
  private readonly providers: ReadonlyMap<ProviderId, Provider>;
  private readonly sessions = new Map<string, Hosted>();
  private readonly listeners = new Set<(sessions: SessionSummary[]) => void>();
  private readonly eventListeners = new Set<SessionEventsListener>();
  // The models each provider and gateway offer, found once per run of the app.
  private readonly modelLists = new Map<string, Promise<ModelOption[]>>();

  constructor(providers: readonly Provider[]) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
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
    const provider = this.provider(providerId);
    if (!(await stat(options.cwd)).isDirectory()) {
      throw new Error('A session works in a folder.');
    }
    const hosted: Hosted = {
      id: randomUUID(),
      provider: providerId,
      cwd: options.cwd,
      openedAt: Date.now(),
      state: initialSessionState(),
      seq: 0,
    };
    this.sessions.set(hosted.id, hosted);
    try {
      hosted.session = await provider.start(options, (event) => {
        this.apply(hosted, event);
      });
    } catch (error) {
      this.sessions.delete(hosted.id);
      throw error;
    }
    this.report(hosted);
    return hosted.id;
  }

  send(id: string, text: string, images: MessageImage[] = []): Promise<void> {
    return this.session(id).send(text, images);
  }

  interrupt(id: string): Promise<void> {
    return this.session(id).interrupt();
  }

  // Passes the user's answer to the session's provider, and records it in the session's state once
  // the provider has taken it; a question's typed answers to secrets are not recorded.
  async answerApproval(id: string, requestId: string, answer: ApprovalAnswer): Promise<void> {
    await this.session(id).answerApproval(requestId, answer);
    this.recordAnswer(id, requestId, answer);
  }

  async answerQuestion(id: string, requestId: string, answer: QuestionAnswer): Promise<void> {
    await this.session(id).answerQuestion(requestId, answer);
    this.recordAnswer(id, requestId, answer);
  }

  setMode(id: string, mode: PermissionMode): Promise<void> {
    return this.session(id).setMode(mode);
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

  setSandbox(id: string, sandbox: SandboxLevel): Promise<void> {
    return this.session(id).setSandbox(sandbox);
  }

  // The session's state so far, or null for a session the host does not have.
  snapshot(id: string): SessionSnapshot | null {
    const hosted = this.sessions.get(id);
    return hosted === undefined ? null : { seq: hosted.seq, state: hosted.state };
  }

  // The listed sessions, newest first.
  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .flatMap((hosted) => (hosted.summary === undefined ? [] : [hosted.summary]))
      .sort((left, right) => right.openedAt - left.openedAt);
  }

  onChange(listener: (sessions: SessionSummary[]) => void): () => void {
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

  // Closes every session and its provider process, as the app does when it quits.
  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].flatMap(({ session }) => (session ? [session.close()] : [])),
    );
  }

  private provider(providerId: ProviderId): Provider {
    const provider = this.providers.get(providerId);
    if (provider === undefined) throw new Error(`${providerId} is not available.`);
    return provider;
  }

  private session(id: string): ProviderSession {
    const session = this.sessions.get(id)?.session;
    if (session === undefined) throw new Error('The session is not open.');
    return session;
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

  private apply(hosted: Hosted, event: SessionEvent): void {
    hosted.state = applyEvent(hosted.state, event);
    hosted.seq += 1;
    for (const listener of this.eventListeners) listener(hosted.id, hosted.seq, event);
    this.report(hosted);
  }

  // Tells the listeners when what the list shows of the session has changed. Until the provider titles
  // the session, its first message stands in for the title.
  private report(hosted: Hosted): void {
    if (hosted.session === undefined) return;
    const title = hosted.state.title ?? firstPrompt(hosted.state);
    const status = sessionStatus(hosted.state);
    const waitingSince =
      status === 'waiting' ? openRequests(hosted.state)[0]?.requestedAt : undefined;
    const summary: SessionSummary = {
      id: hosted.id,
      provider: hosted.provider,
      sessionId: hosted.session.id,
      cwd: hosted.cwd,
      ...(title === undefined ? {} : { title }),
      status,
      openedAt: hosted.openedAt,
      ...(waitingSince === undefined ? {} : { waitingSince }),
    };
    const before = hosted.summary;
    if (
      before !== undefined &&
      before.title === summary.title &&
      before.status === summary.status &&
      before.waitingSince === summary.waitingSince
    ) {
      return;
    }
    hosted.summary = summary;
    const sessions = this.list();
    for (const listener of this.listeners) listener(sessions);
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
