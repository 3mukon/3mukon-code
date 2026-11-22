import type { Socket } from 'node:net';
import { z } from 'zod';

const maxFrame = 1024 * 1024;
const commandTimeout = 7500;
const proof = z.string().regex(/^[a-f0-9]{64}$/);
const tabId = z.int().positive();
const message = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pair'), ticket: proof }),
  z.strictObject({ kind: z.literal('restore'), proof }),
  z.strictObject({ kind: z.literal('pair-saved') }),
  z.strictObject({
    kind: z.literal('reply'),
    id: z.int().positive(),
    ok: z.boolean(),
    result: z.unknown().optional(),
  }),
  z.strictObject({
    kind: z.literal('tab-event'),
    tab: tabId,
    method: z.string().min(1).max(96),
    value: z.unknown(),
  }),
  z.strictObject({ kind: z.literal('tab-ended'), tab: tabId }),
]);
export type ChromeNativeMessage = z.infer<typeof message>;
export type ChromeNativeHandshake = Extract<
  ChromeNativeMessage,
  { kind: 'pair' | 'restore' | 'pair-saved' }
>;

type Request =
  | { kind: 'create-tab' | 'forget' }
  | { kind: 'close-tab'; tab: number }
  | { kind: 'command'; tab: number; method: string; params: object };
interface Pending {
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class ChromeNativePeer {
  private bytes: Buffer = Buffer.alloc(0);
  private closed = false;
  private ready = false;
  private readonly pending = new Map<number, Pending>();
  private readonly tabs = new Map<number, (event: ChromeNativeMessage) => void>();
  private next = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly socket: Socket,
    private readonly handshake: (event: ChromeNativeHandshake) => void,
    private readonly ended: () => void,
  ) {
    this.timer = setTimeout(() => {
      this.close();
    }, commandTimeout);
    socket.on('data', (bytes: Buffer) => {
      this.receive(bytes);
    });
    socket.on('error', () => {
      this.close();
    });
    socket.once('close', () => {
      this.close();
    });
  }

  offer(proof: string): void {
    this.send({ kind: 'paired', proof });
  }

  activate(): void {
    this.ready = true;
    clearTimeout(this.timer);
    this.send({ kind: 'ready' });
  }

  watch(tab: number, receive: (event: ChromeNativeMessage) => void): () => void {
    this.tabs.set(tab, receive);
    return () => {
      this.tabs.delete(tab);
    };
  }

  request(action: Request): Promise<unknown> {
    if (this.closed || !this.ready || this.pending.size >= 32)
      return Promise.reject(new Error('Chrome is unavailable.'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
      }, commandTimeout);
      this.pending.set(id, { timer, resolve, reject });
      this.send({ kind: 'request', id, action });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Chrome disconnected.'));
    }
    this.pending.clear();
    this.tabs.clear();
    this.ended();
  }

  private send(value: object): void {
    if (this.closed) return;
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > maxFrame) {
      this.close();
      return;
    }
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([prefix, body]), (error) => {
      if (error) this.close();
    });
  }

  private receive(bytes: Buffer): void {
    this.bytes = Buffer.concat([this.bytes, bytes]);
    while (!this.closed && this.bytes.length >= 4) {
      const size = this.bytes.readUInt32LE();
      if (!size || size > maxFrame) {
        this.close();
        return;
      }
      if (this.bytes.length < size + 4) return;
      const body = this.bytes.subarray(4, size + 4);
      this.bytes = this.bytes.subarray(size + 4);
      try {
        this.dispatch(message.parse(JSON.parse(body.toString('utf8'))));
      } catch {
        this.close();
        return;
      }
    }
  }

  private dispatch(value: ChromeNativeMessage): void {
    if (value.kind === 'pair' || value.kind === 'restore' || value.kind === 'pair-saved') {
      if (this.ready) this.close();
      else this.handshake(value);
      return;
    }
    if (!this.ready) {
      this.close();
      return;
    }
    if (value.kind === 'reply') {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.ok) pending.resolve(value.result);
      else pending.reject(new Error('Chrome declined the command.'));
      return;
    }
    this.tabs.get(value.tab)?.(value);
  }
}
