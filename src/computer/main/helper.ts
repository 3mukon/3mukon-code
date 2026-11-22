import { randomUUID } from 'node:crypto';
import type { Outcome, PermissionState } from '../../sessions/shared/automation';
import type { ControlCommand } from '../shared/computer';
import type { HelperSetup, HelperStatus } from '../shared/helper';
import { HelperDeadline, HelperWire, ProtocolMismatch, type HelperChild } from './helper-wire';
import type {
  HelperCommand,
  HelperReply,
  NativeControlFrame,
  NativeEvent,
} from './native-protocol';

export const HELPER_NAME = 'Computer Use Helper';
const REQUEST_MS = 2_000;
const OPERATION_MS = 8_000;
const MAX_PENDING = 32;
const okay = <T>(value: T): Outcome<T> => ({ status: 'verified', value });
const refused = <T>(code: Extract<Outcome, { status: 'refused' }>['code']): Outcome<T> => ({
  status: 'refused',
  code,
  dispatched: false,
});
const cancelled = (): Outcome<never> => ({ status: 'cancelled-before-dispatch', effects: 'none' });
const unavailable = <T>(): Outcome<T> => ({
  status: 'refused',
  code: 'setup-required',
  dispatched: false,
  detail: { kind: 'availability', reason: { code: 'backend-unavailable', backend: 'native' } },
});
const permission = (granted: boolean): PermissionState => (granted ? 'granted' : 'not-granted');

type InactiveConnection = Exclude<HelperStatus['connection'], 'ready'>;
type Query = Exclude<HelperCommand['kind'], 'hello'>;
type ApplicationInventory = HelperReply<'applications'>['inventory'] & { generation: string };
type NativeCommand = Exclude<HelperCommand, { kind: 'hello' | 'permissions' | 'applications' }>;
type Operation<C> = C extends NativeCommand ? Omit<C, 'deadline'> : never;
type NativeQuery = Operation<NativeCommand>;
type NativeValue<K extends NativeQuery['kind']> = Extract<
  HelperReply<K>['result'],
  { status: 'verified' }
>['value'];
interface Binding {
  generation: string;
  signal: AbortSignal;
  event?: (event: NativeEvent) => void;
}

function inactive(connection: InactiveConnection): HelperStatus {
  const state = connection === 'idle' ? 'unknown' : 'unavailable';
  return {
    connection,
    generation: null,
    checkedAt: null,
    permissions: {
      helperName: HELPER_NAME,
      accessibility: state,
      screenRecording: state,
      inputMonitoring: { required: false, state },
      restartRequired: false,
    },
  };
}

// An app-owned process that starts on demand for setup or explicit metadata discovery. The host
// chooses its executable, coordination root and protocol messages.
export class NativeHelper implements HelperSetup {
  private current = inactive('idle');
  private wire: HelperWire | undefined;
  private checking: Promise<Outcome<HelperStatus>> | undefined;
  private discovering: Promise<Outcome<ApplicationInventory>> | undefined;
  private requests: Promise<unknown> | undefined;
  private pending = 0;
  private inputMonitoringRequired = false;
  private restarting: Promise<Outcome<HelperStatus>> | undefined;
  private drain: Promise<void> | undefined;
  private epoch = 0;
  private closed = false;

  constructor(
    private readonly launch: () => Promise<HelperChild>,
    private readonly generationEnded: (id: string) => void = () => undefined,
    private readonly controlCommand: (revision: number, command: ControlCommand) => void = () =>
      undefined,
  ) {}

  status(): HelperStatus {
    const value = structuredClone(this.current);
    value.permissions.inputMonitoring.required = this.inputMonitoringRequired;
    return value;
  }

  control(revision: number, frame: NativeControlFrame | null): boolean {
    return this.wire?.control(revision, frame) ?? false;
  }

  check(): Promise<Outcome<HelperStatus>> {
    if (this.closed) return Promise.resolve(unavailable());
    if (this.restarting) return this.restarting;
    return this.refreshPermissions();
  }

  runningApplications(): Promise<Outcome<ApplicationInventory>> {
    if (this.closed) return Promise.resolve(unavailable());
    const query = () => this.query({ kind: 'applications' });
    this.discovering ??= (this.restarting ? this.restarting.then(query) : query())
      .then((outcome) =>
        this.forCurrentGeneration(outcome, (reply) => ({
          ...reply.inventory,
          generation: reply.generation.toLowerCase(),
        })),
      )
      .finally(() => {
        this.discovering = undefined;
      });
    return this.discovering;
  }

  async operate<K extends NativeQuery['kind']>(
    command: Extract<NativeQuery, { kind: K }>,
    binding: Binding,
  ): Promise<Outcome<NativeValue<K>>> {
    const reply = await this.query<K>({ ...command, deadline: Date.now() + OPERATION_MS }, binding);
    if (reply.status !== 'verified') return reply;
    const result = (reply.value as HelperReply<NativeQuery['kind']>).result;
    switch (result.status) {
      case 'verified':
        return okay(result.value as NativeValue<K>);
      case 'dispatched':
        return { status: 'dispatched', evidence: 'not-verified' };
      case 'cancelled-before-dispatch':
        return cancelled();
      case 'indeterminate':
        return { ...result, exclusionHeld: false };
      case 'refused':
        if (result.permission === 'input-monitoring') this.inputMonitoringRequired = true;
        return {
          status: 'refused',
          code: result.code,
          dispatched: false,
          ...(result.permission
            ? {
                detail: {
                  kind: 'setup',
                  requirement: { kind: 'permission', permission: result.permission },
                },
              }
            : {}),
        };
    }
  }

  restart(): Promise<Outcome<HelperStatus>> {
    if (this.closed) return Promise.resolve(unavailable());
    this.restarting ??= this.stop()
      .then(() => this.refreshPermissions())
      .finally(() => {
        this.restarting = undefined;
      });
    return this.restarting;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.stop();
  }

  private refreshPermissions(): Promise<Outcome<HelperStatus>> {
    if (this.closed) return Promise.resolve(unavailable());
    this.checking ??= this.query({ kind: 'permissions' })
      .then((outcome) =>
        this.forCurrentGeneration(outcome, ({ permissions }) => {
          this.current = {
            ...this.current,
            checkedAt: Date.now(),
            permissions: {
              helperName: HELPER_NAME,
              accessibility: permission(permissions.accessibility),
              screenRecording: permission(permissions.screenRecording),
              inputMonitoring: {
                required: false,
                state: permission(permissions.inputMonitoring),
              },
              restartRequired: false,
            },
          };
          return this.status();
        }),
      )
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  private forCurrentGeneration<R extends { generation: string }, T>(
    outcome: Outcome<R>,
    project: (reply: R) => T,
  ): Outcome<T> {
    if (outcome.status !== 'verified') return outcome;
    if (this.wire?.generation !== outcome.value.generation.toLowerCase()) return unavailable();
    return okay(project(outcome.value));
  }

  private query<K extends Query>(
    command: HelperCommand & { kind: K },
    binding?: Binding,
  ): Promise<Outcome<HelperReply<K>>> {
    if (this.closed) return Promise.resolve(unavailable());
    if (this.pending >= MAX_PENDING) return Promise.resolve(refused('busy'));
    const epoch = this.epoch;
    const run = () => this.inspect<K>(epoch, command, binding);
    this.pending++;
    const reply = (this.requests ? this.requests.then(run) : run()).finally(() => {
      this.pending--;
      if (this.requests === reply) this.requests = undefined;
    });
    this.requests = reply;
    return reply;
  }

  private async inspect<K extends Query>(
    epoch: number,
    command: HelperCommand & { kind: K },
    binding?: Binding,
  ): Promise<Outcome<HelperReply<K>>> {
    let dispatched = false;
    try {
      await this.drain;
      if (binding?.signal.aborted) return cancelled();
      if (binding && this.wire?.generation !== binding.generation) return refused('stale-target');
      if (!this.isCurrent(epoch)) return unavailable();
      let wire = this.wire;
      if (!wire) {
        const child = await this.launch();
        if (!this.isCurrent(epoch)) {
          await child.stop();
          return unavailable();
        }
        const newWire = new HelperWire(
          child,
          randomUUID(),
          (error) => {
            if (this.wire !== newWire) return;
            this.retire(
              newWire,
              error instanceof ProtocolMismatch ? 'protocol-mismatch' : 'unavailable',
            );
          },
          (revision, command) => {
            if (this.wire === newWire) this.controlCommand(revision, command);
          },
        );
        this.wire = wire = newWire;
        await wire.request({ kind: 'hello' }, REQUEST_MS);
      }
      if (this.wire !== wire || !this.isCurrent(epoch)) return unavailable();
      if (binding?.signal.aborted) return cancelled();
      dispatched = command.kind === 'action';
      const budget = 'deadline' in command ? OPERATION_MS + 2_000 : REQUEST_MS;
      const reply = await wire.request<K>(command, budget, binding?.signal, binding?.event);
      if (this.wire !== wire || !this.isCurrent(epoch)) {
        await this.drain;
        return dispatched ? this.lostAction(binding) : unavailable();
      }
      if (this.current.generation !== wire.generation) {
        this.current = { ...inactive('idle'), connection: 'ready', generation: wire.generation };
      }
      return okay(reply);
    } catch (error) {
      if (epoch === this.epoch) {
        const state = error instanceof ProtocolMismatch ? 'protocol-mismatch' : 'unavailable';
        if (this.wire) this.retire(this.wire, state);
        else this.current = inactive(state);
      }
      // Retirement waits for the specific child. An executor must keep its broker lease until the
      // process can no longer post input, even when the provider's call has already been cancelled.
      await this.drain;
      return dispatched ? this.lostAction(binding, error instanceof HelperDeadline) : unavailable();
    }
  }

  private lostAction(binding?: Binding, timedOut = false): Outcome<never> {
    const reason: unknown = binding?.signal.reason;
    return {
      status: 'indeterminate',
      reason:
        timedOut || reason === 'deadline'
          ? 'timeout'
          : binding?.signal.aborted && reason !== 'backend-lost'
            ? 'cancelled-after-dispatch'
            : 'backend-lost',
      exclusionHeld: false,
    };
  }

  private isCurrent(epoch: number): boolean {
    return !this.closed && epoch === this.epoch;
  }

  private retire(wire: HelperWire, state: InactiveConnection): void {
    this.wire = undefined;
    this.current = inactive(state);
    wire.close();
    this.drain = wire.child.stop();
    this.generationEnded(wire.generation);
  }

  private async stop(): Promise<void> {
    this.epoch++;
    const wire = this.wire;
    if (wire) this.retire(wire, 'idle');
    else this.current = inactive('idle');
    await this.checking;
    await this.requests;
    await this.drain;
  }
}
