import { randomUUID } from 'node:crypto';
import {
  getSessionMessages,
  listSessions,
  query,
  type CanUseTool,
  type PermissionMode as ClaudePermissionMode,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  Provider,
  ProviderSession,
  SessionEventListener,
} from '../../../sessions/main/provider';
import type {
  ApprovalAnswer,
  PermissionMode,
  QuestionAnswer,
  SessionEvent,
} from '../../../sessions/shared/events';
import { approvalResult, questionResult, toRequest, type ClaudeRequest } from './requests';
import { Translator } from './translate';

// Claude Code's own mode behind each of the app's two permission modes: in auto, Claude Code's
// classifier approves or denies each action and asks through canUseTool only when it cannot decide.
export const nativeModes: Record<PermissionMode, ClaudePermissionMode> = {
  auto: 'auto',
  yolo: 'bypassPermissions',
};

// Claude Code through the Claude Agent SDK, on whatever sign-in Claude Code itself has.
export function createClaudeCodeProvider(): Provider {
  return {
    id: 'claude-code',
    start(options, onEvent) {
      const settings = {
        cwd: options.cwd,
        mode: options.mode ?? 'auto',
        sessionId: randomUUID(),
        resume: false,
      };
      return ClaudeCodeSession.open(settings, onEvent, new Translator(options.cwd));
    },
    async resume(options, onEvent) {
      const translator = new Translator(options.cwd);
      for (const message of await getSessionMessages(options.sessionId, { dir: options.cwd })) {
        for (const event of translator.history(message)) onEvent(event);
      }
      onEvent({ type: 'replay-finished' });
      const settings = {
        cwd: options.cwd,
        mode: options.mode ?? 'auto',
        sessionId: options.sessionId,
        resume: true,
      };
      return ClaudeCodeSession.open(settings, onEvent, translator);
    },
    async listSessions(cwd, limit) {
      const sessions = await listSessions({ dir: cwd, limit });
      return sessions.map((session) => ({
        id: session.sessionId,
        title: session.customTitle ?? session.summary,
        cwd: session.cwd ?? cwd,
        updatedAt: session.lastModified,
      }));
    },
  };
}

interface SessionSettings {
  cwd: string;
  mode: PermissionMode;
  sessionId: string;
  resume: boolean;
}

class ClaudeCodeSession implements ProviderSession {
  readonly id: string;
  private readonly input = new InputQueue();
  private readonly query: Query;
  private readonly pending = new Map<
    string,
    { request: ClaudeRequest; resolve: (result: PermissionResult) => void }
  >();
  private mode: PermissionMode;
  private turnRunning = false;
  private interrupting = false;
  private closed = false;

  // Resolves once Claude Code has started and answered the SDK's initialization.
  static async open(
    settings: SessionSettings,
    onEvent: SessionEventListener,
    translator: Translator,
  ): Promise<ClaudeCodeSession> {
    const session = new ClaudeCodeSession(settings, onEvent, translator);
    try {
      await session.query.initializationResult();
    } catch (error) {
      session.query.close();
      throw error;
    }
    return session;
  }

  private constructor(
    private readonly settings: SessionSettings,
    private readonly onEvent: SessionEventListener,
    private readonly translator: Translator,
  ) {
    this.id = settings.sessionId;
    this.mode = settings.mode;
    this.query = query({
      prompt: this.input,
      options: {
        cwd: settings.cwd,
        permissionMode: nativeModes[settings.mode],
        // Lets a session switch to yolo later; it starts in, and stays in, the mode chosen.
        allowDangerouslySkipPermissions: true,
        // Text and thinking arrive as they are written.
        includePartialMessages: true,
        // Claude Code's own system prompt, as in the CLI; its settings and CLAUDE.md files load as
        // they do there.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        canUseTool: this.canUseTool,
        ...(settings.resume ? { resume: settings.sessionId } : { sessionId: settings.sessionId }),
      },
    });
    onEvent({ type: 'mode', mode: settings.mode });
    void this.pump();
  }

  send(text: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The session is closed.'));
    this.turnRunning = true;
    this.onEvent({ type: 'turn-started' });
    this.onEvent({ type: 'message', id: randomUUID(), role: 'user', text });
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    return Promise.resolve();
  }

  async interrupt(): Promise<void> {
    if (!this.turnRunning) return;
    this.interrupting = true;
    await this.query.interrupt();
  }

  answerApproval(requestId: string, answer: ApprovalAnswer): Promise<void> {
    const pending = this.pending.get(requestId);
    if (pending?.request.kind !== 'approval') {
      return Promise.reject(new Error(`No approval ${requestId} is waiting.`));
    }
    this.pending.delete(requestId);
    pending.resolve(approvalResult(pending.request, answer, nativeModes[this.mode]));
    this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
    if (pending.request.request.action === 'plan' && answer.decision !== 'deny') {
      this.onEvent({ type: 'mode', mode: this.mode });
    }
    return Promise.resolve();
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): Promise<void> {
    const pending = this.pending.get(requestId);
    if (pending?.request.kind !== 'question') {
      return Promise.reject(new Error(`No question ${requestId} is waiting.`));
    }
    this.pending.delete(requestId);
    pending.resolve(questionResult(pending.request, answer));
    this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
    return Promise.resolve();
  }

  async setMode(mode: PermissionMode): Promise<void> {
    await this.query.setPermissionMode(nativeModes[mode]);
    this.mode = mode;
    this.onEvent({ type: 'mode', mode });
  }

  close(): Promise<void> {
    this.input.end();
    this.query.close();
    return Promise.resolve();
  }

  // Every canUseTool call waits here for the user's answer, or for the SDK to give up on it.
  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
    const request = toRequest(toolName, input, options, {
      cwd: this.settings.cwd,
      now: Date.now(),
    });
    const id = request.request.id;
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(id, { request, resolve });
      options.signal.addEventListener(
        'abort',
        () => {
          if (!this.pending.delete(id)) return;
          resolve({ behavior: 'deny', message: 'The turn was interrupted.' });
          this.onEvent({ type: 'request-resolved', requestId: id, outcome: 'cancelled' });
        },
        { once: true },
      );
      this.onEvent(
        request.kind === 'question'
          ? { type: 'question-asked', request: request.request }
          : { type: 'approval-requested', request: request.request },
      );
    });
  };

  private async pump(): Promise<void> {
    let error: string | undefined;
    try {
      for await (const message of this.query) {
        for (const event of this.translator.live(message)) this.emit(event);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      pending.resolve({ behavior: 'deny', message: 'The session ended.' });
      this.onEvent({ type: 'request-resolved', requestId, outcome: 'cancelled' });
    }
    this.pending.clear();
    this.onEvent(error === undefined ? { type: 'closed' } : { type: 'closed', error });
  }

  private emit(event: SessionEvent): void {
    if (event.type !== 'turn-ended') {
      this.onEvent(event);
      return;
    }
    this.turnRunning = false;
    if (this.interrupting) {
      this.interrupting = false;
      this.onEvent({ type: 'turn-ended', outcome: 'interrupted' });
    } else {
      this.onEvent(event);
    }
  }
}

// The session's input: the user's messages wait here until Claude Code reads them.
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly waiting: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(message: SDKUserMessage): void {
    this.waiting.push(message);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.waiting.shift();
      if (next !== undefined) {
        yield next;
      } else if (this.ended) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
      }
    }
  }
}
