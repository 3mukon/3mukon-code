import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RequestId } from './protocol/RequestId';

// What the app-server sends without being asked.
export interface RpcHandlers {
  notification(method: string, params: unknown): void;
  // Resolves to the request's result, or rejects to answer it with an error.
  request(method: string, params: unknown, id: RequestId): Promise<unknown>;
  // The app-server has stopped; error is set when it stopped without being closed.
  exit(error: string | undefined): void;
}

// A connection to one app-server process.
export interface Rpc {
  request<Result>(method: string, params: unknown): Promise<Result>;
  notify(method: string, params?: unknown): void;
  // Ends the process; resolves once it has exited. Called again, it only waits.
  close(): Promise<void>;
}

// What a session adds to its app-server's command line and environment.
export interface Launch {
  args: string[];
  env: Record<string, string>;
}

export type StartRpc = (cwd: string, handlers: RpcHandlers, launch?: Launch) => Rpc;

// An error from Codex, with the kind of error that Codex's answer names, such as
// modelProviderMismatch, where it names one. Of the answer's data only that kind is kept, since the rest
// may repeat a gateway's settings.
export class CodexError extends Error {
  constructor(
    message: string,
    readonly kind: string | undefined,
  ) {
    super(message);
  }
}

interface Waiting {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

// codex app-server over standard input and output: JSON-RPC 2.0 without the jsonrpc member, one message
// per line. Its log output is drained and never kept, since Codex may print its settings there.
export class CodexRpc implements Rpc {
  private nextId = 1;
  private readonly waiting = new Map<RequestId, Waiting>();
  private closing = false;
  private ended = false;
  private markExited: () => void = () => undefined;
  private readonly exited = new Promise<void>((resolve) => {
    this.markExited = resolve;
  });

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: RpcHandlers,
  ) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      this.receive(line);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {
      // The process has gone; its exit reports it.
    });
    child.on('error', (error) => {
      this.end(`Codex could not start: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      this.end(`Codex stopped unexpectedly (${signal ?? `exit code ${String(code)}`}).`);
    });
  }

  // Starts `codex app-server` in the folder, with the app's environment and what the launch adds.
  static start(
    binary: string,
    cwd: string,
    handlers: RpcHandlers,
    launch: Launch = { args: [], env: {} },
  ): CodexRpc {
    const child = spawn(binary, ['app-server', ...launch.args], {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, ...launch.env },
    });
    return new CodexRpc(child, handlers);
  }

  request<Result>(method: string, params: unknown): Promise<Result> {
    if (this.ended) return Promise.reject(new Error('Codex has stopped.'));
    const id = this.nextId++;
    return new Promise<Result>((resolve, reject) => {
      this.waiting.set(id, {
        resolve: (result) => {
          resolve(result as Result);
        },
        reject,
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  close(): Promise<void> {
    if (!this.closing && !this.ended) {
      this.child.stdin.end();
      this.child.kill();
    }
    this.closing = true;
    return this.exited;
  }

  private write(message: object): void {
    if (!this.ended) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id as RequestId | undefined;
    if (typeof message.method === 'string') {
      if (id === undefined) this.handlers.notification(message.method, message.params);
      else void this.answer(id, message.method, message.params);
      return;
    }
    if (id === undefined) return;
    const waiting = this.waiting.get(id);
    if (waiting === undefined) return;
    this.waiting.delete(id);
    const error = message.error as { message?: unknown; data?: unknown } | undefined;
    if (error === undefined) waiting.resolve(message.result);
    else {
      const kind = (error.data as { type?: unknown } | null | undefined)?.type;
      waiting.reject(
        new CodexError(
          typeof error.message === 'string' ? error.message : 'Codex refused the request.',
          typeof kind === 'string' ? kind : undefined,
        ),
      );
    }
  }

  private async answer(id: RequestId, method: string, params: unknown): Promise<void> {
    try {
      this.write({ id, result: await this.handlers.request(method, params, id) });
    } catch (error) {
      this.write({
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private end(error: string): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiting of this.waiting.values()) waiting.reject(new Error('Codex has stopped.'));
    this.waiting.clear();
    this.handlers.exit(this.closing ? undefined : error);
    this.markExited();
  }
}
