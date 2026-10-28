import { randomUUID } from 'node:crypto';
import type { ProviderId, SessionEvent } from '../shared/events';
import {
  applyEvent,
  initialSessionState,
  sessionStatus,
  type SessionState,
} from '../shared/session-state';
import type { SessionSummary } from '../shared/sessions';
import type { Provider, ProviderSession, StartOptions } from './provider';

interface Hosted {
  id: string;
  provider: ProviderId;
  cwd: string;
  openedAt: number;
  // Folded from every event of the session, from the first.
  state: SessionState;
  // Set once the provider has started the session, which is listed from then on.
  session?: ProviderSession;
  // What the list last reported of the session.
  summary?: SessionSummary;
}

// The app's open sessions, which run in the main process through the providers' adapters. Each one's
// state is folded from its events as they arrive, and listeners hear whenever a session joins the
// list or its title or status changes; a closed session stays on the list as closed.
export class SessionHost {
  private readonly providers: ReadonlyMap<ProviderId, Provider>;
  private readonly sessions = new Map<string, Hosted>();
  private readonly listeners = new Set<(sessions: SessionSummary[]) => void>();

  constructor(providers: readonly Provider[]) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  // Starts a session and resolves with the app's id for it once the provider has started it. It
  // rejects when the provider is not available or refuses.
  async start(providerId: ProviderId, options: StartOptions): Promise<string> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) throw new Error(`${providerId} is not available.`);
    const hosted: Hosted = {
      id: randomUUID(),
      provider: providerId,
      cwd: options.cwd,
      openedAt: Date.now(),
      state: initialSessionState(),
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

  // Closes every session and its provider process, as the app does when it quits.
  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].flatMap(({ session }) => (session ? [session.close()] : [])),
    );
  }

  private apply(hosted: Hosted, event: SessionEvent): void {
    hosted.state = applyEvent(hosted.state, event);
    this.report(hosted);
  }

  // Tells the listeners when what the list shows of the session has changed.
  private report(hosted: Hosted): void {
    if (hosted.session === undefined) return;
    const summary: SessionSummary = {
      id: hosted.id,
      provider: hosted.provider,
      sessionId: hosted.session.id,
      cwd: hosted.cwd,
      ...(hosted.state.title === undefined ? {} : { title: hosted.state.title }),
      status: sessionStatus(hosted.state),
      openedAt: hosted.openedAt,
    };
    const before = hosted.summary;
    if (
      before !== undefined &&
      before.title === summary.title &&
      before.status === summary.status
    ) {
      return;
    }
    hosted.summary = summary;
    const sessions = this.list();
    for (const listener of this.listeners) listener(sessions);
  }
}
