import { randomUUID } from 'node:crypto';
import type { Outcome, PermissionState } from '../../sessions/shared/automation';
import type { ControlEvent } from '../shared/computer';
import {
  HELPER_NAME,
  type HelperPermission,
  type HelperSetup,
  type HelperStatus,
} from '../shared/helper';
import { HelperDeadline, HelperWire, ProtocolMismatch, type HelperChild } from './helper-wire';
import type {
  HelperCommand,
  HelperReply,
  NativeControlFrame,
  NativeEvent,
} from './native-protocol';

const REQUEST_MS = 2_000;
const OPERATION_MS = 8_000;
const MAX_PENDING = 32;
const noop = () => undefined;
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
// macOS gives a running process some permissions only once it starts again, so `fresh` is what a
// process that has just started has.
const permission = (granted: boolean, fresh: boolean | undefined): PermissionState =>
  granted ? 'granted' : fresh ? 'restart-required' : 'not-granted';

type InactiveConnection = Exclude<HelperStatus['connection'], 'ready'>;
type Query = Exclude<HelperCommand['kind'], 'hello'>;
type Permissions = HelperReply<'permissions'>['permissions'];
type ApplicationInventory = HelperReply<'applications'>['inventory'] & { generation: string };
type NativeCommand = Exclude<
  HelperCommand,
  { kind: 'hello' | 'permissions' | 'request-permission' | 'applications' }
>;
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
  private probe: HelperChild | undefined;
  private epoch = 0;
  private closed = false;

  constructor(
    private readonly launch: () => Promise<HelperChild>,
    private readonly generationEnded: (id: string) => void = () => undefined,
    private readonly controlCommand: (revision: number, command: ControlEvent) => void = () =>
      undefined,
    // Whether macOS registers the stop shortcut, as each helper says when it starts.
    private readonly stopShortcut: (registers: boolean) => void = () => undefined,
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
      case 'refused': {
        const missing = result.permission;
        if (missing === 'input-monitoring') this.inputMonitoringRequired = true;
        // A preview that cannot be taken is asked for again each second.
        const restart =
          missing && command.kind !== 'preview' && (await this.restartAllows(missing));
        return {
          status: 'refused',
          code: result.code,
          dispatched: false,
          ...(missing
            ? {
                detail: {
                  kind: 'setup',
                  requirement: restart
                    ? { kind: 'restart-helper' }
                    : { kind: 'permission', permission: missing },
                },
              }
            : {}),
        };
      }
    }
  }

  async request(missing: HelperPermission): Promise<Outcome<{ prompted: boolean }>> {
    const reply = await this.query({ kind: 'request-permission', permission: missing });
    return reply.status === 'verified' ? okay({ prompted: reply.value.prompted }) : reply;
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
    this.checking ??= this.readPermissions().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async readPermissions(): Promise<Outcome<HelperStatus>> {
    const running = this.wire;
    const outcome = await this.query({ kind: 'permissions' });
    if (outcome.status !== 'verified') return outcome;
    const has = outcome.value.permissions;
    const lacks =
      !has.accessibility ||
      !has.screenRecording ||
      (this.inputMonitoringRequired && !has.inputMonitoring);
    const fresh = running && lacks ? await this.freshPermissions() : undefined;
    return this.forCurrentGeneration(outcome, () => {
      const accessibility = permission(has.accessibility, fresh?.accessibility);
      const screenRecording = permission(has.screenRecording, fresh?.screenRecording);
      const state = permission(has.inputMonitoring, fresh?.inputMonitoring);
      const needed = [
        accessibility,
        screenRecording,
        ...(this.inputMonitoringRequired ? [state] : []),
      ];
      this.current = {
        ...this.current,
        checkedAt: Date.now(),
        permissions: {
          helperName: HELPER_NAME,
          accessibility,
          screenRecording,
          inputMonitoring: { required: false, state },
          restartRequired: needed.includes('restart-required'),
        },
      };
      return this.status();
    });
  }

  // What macOS gives the helper as it starts. A permission the user allowed while the helper runs
  // may reach only a process that starts after that.
  private async freshPermissions(): Promise<Permissions | undefined> {
    const epoch = this.epoch;
    let child: HelperChild | undefined;
    try {
      child = this.probe = await this.launch();
      if (!this.isCurrent(epoch)) return undefined;
      const wire = new HelperWire(child, randomUUID(), noop, noop);
      await wire.request({ kind: 'hello' }, REQUEST_MS);
      return (await wire.request({ kind: 'permissions' }, REQUEST_MS)).permissions;
    } catch {
      return undefined;
    } finally {
      this.probe = undefined;
      await child?.stop();
    }
  }

  private async restartAllows(missing: HelperPermission): Promise<boolean> {
    const checked = await this.check();
    if (checked.status !== 'verified') return false;
    const { accessibility, screenRecording, inputMonitoring } = checked.value.permissions;
    const states = {
      accessibility,
      'screen-recording': screenRecording,
      'input-monitoring': inputMonitoring.state,
    };
    return states[missing] === 'restart-required';
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
        const hello = await wire.request({ kind: 'hello' }, REQUEST_MS);
        this.stopShortcut(hello.stopShortcut);
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
    await this.probe?.stop();
    await this.checking;
    await this.requests;
    await this.drain;
  }
}
