import type { Readable, Writable } from 'node:stream';
import type { ControlCommand } from '../shared/computer';
import {
  helperControlCommand,
  helperEvent,
  helperResponse,
  NATIVE_CONTROL_BYTES,
  NATIVE_FRAME_BYTES,
  NATIVE_REQUEST_BYTES,
  NATIVE_WIRE_VERSION,
  type HelperCommand,
  type HelperReply,
  type HelperResponse,
  type NativeControlFrame,
  type NativeEvent,
} from './native-protocol';

export interface HelperChild {
  pid: number;
  input: Writable;
  output: Readable;
  exit: Promise<void>;
  stop(): Promise<void>;
}

export class ProtocolMismatch extends Error {
  constructor() {
    super('Unexpected native helper protocol.');
  }
}

export class HelperDeadline extends Error {
  constructor() {
    super('Native helper request timed out.');
  }
}

interface Pending {
  kind: HelperCommand['kind'];
  timer: ReturnType<typeof setTimeout>;
  detach(): void;
  events: number;
  event?: (event: NativeEvent) => void;
  reply(value: HelperResponse): void;
  fail(error: Error): void;
}

export class HelperWire {
  private pending: Pending | undefined;
  private bytes = Buffer.alloc(0);
  private sequence = 0;
  private controlRevision = 0;
  private controlVisible = false;
  private failed: Error | undefined;

  constructor(
    readonly child: HelperChild,
    readonly generation: string,
    private readonly lost: (error: Error) => void,
    private readonly controlCommand: (revision: number, command: ControlCommand) => void,
  ) {
    child.output.on('data', (chunk: Buffer) => {
      this.receive(chunk);
    });
    child.output.on('error', () => {
      this.fail(new Error('Native helper pipe failed.'));
    });
    child.input.on('error', () => {
      this.fail(new Error('Native helper pipe failed.'));
    });
    void child.exit.then(() => {
      this.fail(new Error('Native helper exited.'));
    });
  }

  control(id: number, frame: NativeControlFrame | null): boolean {
    if (this.failed || id <= this.controlRevision) return false;
    const data = JSON.stringify({
      kind: 'control',
      version: NATIVE_WIRE_VERSION,
      generation: this.generation,
      id,
      frame,
    });
    if (Buffer.byteLength(data) > NATIVE_CONTROL_BYTES) return false;
    this.controlRevision = id;
    this.controlVisible = frame !== null;
    this.child.input.write(data + '\n');
    return true;
  }

  async request<K extends HelperCommand['kind']>(
    command: HelperCommand & { kind: K },
    timeout: number,
    signal?: AbortSignal,
    event?: (event: NativeEvent) => void,
  ): Promise<HelperReply<K>> {
    if (this.failed) throw this.failed;
    if (this.pending) throw new Error('A native request is already running.');
    const id = ++this.sequence;
    const header = { version: NATIVE_WIRE_VERSION, generation: this.generation, id };
    const data = JSON.stringify({ ...command, ...header });
    if (Buffer.byteLength(data) > NATIVE_REQUEST_BYTES)
      throw new Error('Native request too large.');
    const value = await new Promise<HelperResponse>((reply, fail) => {
      const timer = setTimeout(() => {
        this.fail(new HelperDeadline());
      }, timeout);
      timer.unref();
      const cancel = () => {
        this.child.input.write(JSON.stringify({ kind: 'cancel', ...header }) + '\n');
      };
      this.pending = {
        kind: command.kind,
        timer,
        reply,
        fail,
        events: 0,
        event,
        detach: () => {
          signal?.removeEventListener('abort', cancel);
        },
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.child.input.write(data + '\n');
    });
    return value as HelperReply<K>;
  }

  close(): void {
    this.fail(new Error('Native helper connection closed.'), false);
    this.child.input.end();
  }

  private receive(part: Buffer): void {
    if (this.failed) return;
    let offset = 0;
    while (offset < part.length) {
      const line = part.indexOf(10, offset);
      const end = line === -1 ? part.length : line;
      // Larger image replies are available only on the explicit observation route.
      const limit = this.pending?.kind === 'observe' ? NATIVE_FRAME_BYTES : 32 * 1024;
      if (this.bytes.length + end - offset > limit) {
        this.fail(new ProtocolMismatch());
        return;
      }
      this.bytes = Buffer.concat([this.bytes, part.subarray(offset, end)]);
      if (line === -1) return;
      const frame = this.bytes;
      this.bytes = Buffer.alloc(0);
      if (!this.frame(frame, this.pending)) return;
      offset = line + 1;
    }
  }

  private frame(frame: Buffer, pending: Pending | undefined): boolean {
    let value: unknown;
    try {
      value = JSON.parse(frame.toString('utf8'));
    } catch {
      this.fail(new ProtocolMismatch());
      return false;
    }
    const control = helperControlCommand.safeParse(value);
    if (
      control.success &&
      control.data.generation.toLowerCase() === this.generation &&
      control.data.id <= this.controlRevision
    ) {
      if (this.controlVisible && control.data.id === this.controlRevision)
        this.controlCommand(control.data.id, control.data.event);
      return !this.failed;
    }
    if (!pending) {
      this.fail(new ProtocolMismatch());
      return false;
    }
    const event = helperEvent.safeParse(value);
    if (event.success && pending.kind === 'action' && this.matches(event.data)) {
      if (++pending.events > 8) {
        this.fail(new ProtocolMismatch());
        return false;
      }
      try {
        pending.event?.(event.data.event);
      } catch {
        this.fail(new Error('Native event handling failed.'));
      }
      return !this.failed;
    }
    const parsed = helperResponse.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.kind !== pending.kind ||
      !this.matches(parsed.data) ||
      (parsed.data.kind === 'hello' && parsed.data.pid !== this.child.pid)
    ) {
      this.fail(new ProtocolMismatch());
      return false;
    }
    clearTimeout(pending.timer);
    pending.detach();
    this.pending = undefined;
    pending.reply(parsed.data);
    return true;
  }

  private matches(frame: { generation: string; id: number }): boolean {
    return frame.generation.toLowerCase() === this.generation && frame.id === this.sequence;
  }

  private fail(error: Error, notify = true): void {
    if (this.failed) return;
    this.failed = error;
    const pending = this.pending;
    this.pending = undefined;
    this.bytes = Buffer.alloc(0);
    if (pending) {
      clearTimeout(pending.timer);
      pending.detach();
      pending.fail(error);
    }
    if (notify) this.lost(error);
  }
}
