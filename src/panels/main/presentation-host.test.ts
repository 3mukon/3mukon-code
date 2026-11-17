import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakePresentationWindow } from '../shared/presentation-fake';
import {
  DEFAULT_PLACEMENT,
  PRESENTATION_HOLD_MS,
  type PresentationHostMessage,
  type PresentationRendererMessage,
} from '../shared/presentation';
import type { PanelRequest, PanelResult } from '../shared/presentation-host';
import type { Outcome, PresentationNotice } from '../../sessions/shared/automation';
import { PresentationHost, PRESENTATION_HOST_LIMITS } from './presentation-host';

const present = (reuseKey = 'result', version = 0): Extract<PanelRequest, { kind: 'present' }> => ({
  kind: 'present',
  reuseKey,
  version,
  title: 'Fixture',
  items: [{ kind: 'file', path: '/allowed/result.md' }],
  placement: DEFAULT_PLACEMENT,
});
const shown = (result: PanelResult) => {
  expect(result.outcome.status).toBe('verified');
  const p = result.presentations?.[0];
  if (!p) throw Error('No presentation');
  return p;
};
function fixture() {
  const owners = new Set(['a', 'b']);
  const sent: PresentationHostMessage[] = [];
  const reports: PresentationRendererMessage[] = [];
  const notice = vi.fn<(owner: string, notice: PresentationNotice) => Outcome<null>>(() => ({
    status: 'verified',
    value: null,
  }));
  const file = vi.fn((_owner: string, path: string) =>
    Promise.resolve(path.startsWith('/allowed/') ? path : null),
  );
  const host = new PresentationHost({
    hasOwner: (id) => owners.has(id),
    file,
    notice,
    resource: (owner, content) =>
      content.kind === 'browser' && content.tabId === `${owner}-tab` ? 'Synthetic page' : null,
  });
  let held = false;
  const connect = () => {
    host.connect((message) => {
      sent.push(message);
      window.receive(message);
    });
  };
  connect();
  const window: FakePresentationWindow = new FakePresentationWindow(
    (message) => {
      if (held && ['applied', 'cancelled', 'refused'].includes(message.kind)) reports.push(message);
      else host.receive(message);
    },
    ['a', 'b'],
  );
  let serial = 0;
  return {
    host,
    window,
    sent,
    reports,
    notice,
    file,
    owners,
    hold(value = true) {
      held = value;
    },
    reload() {
      connect();
      window.reload();
    },
    run(request: PanelRequest, owner = 'a', signal = new AbortController().signal) {
      return host.execute(owner, String(++serial), request, signal);
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
});

describe('the acknowledged panel host', () => {
  it('answers a repeated Show once, without a competing busy answer or reopening after another close', async () => {
    const f = fixture();
    const p = shown(await f.run(present()));
    f.window.close(p.id);
    const request = {
      kind: 'show',
      epoch: f.window.epoch,
      requestId: 'same-show',
      owner: 'a',
      presentationId: p.id,
    };
    f.host.receive(request);
    f.host.receive(request);
    await vi.waitFor(() => {
      expect(f.window.showOutcomes.get('same-show')).toBe('shown');
    });
    f.window.close(p.id);
    f.host.receive(request);
    await Promise.resolve();
    expect(f.sent.filter((message) => message.kind === 'present')).toHaveLength(2);
    expect(f.sent.filter((message) => message.kind === 'show-answer')).toEqual([
      { kind: 'show-answer', epoch: f.window.epoch, requestId: 'same-show', outcome: 'shown' },
    ]);
    f.host.disconnect();
  });
  it('bounds the whole Show wait, including file validation, and never dispatches after its deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const p = shown(await f.run(present()));
    f.window.close(p.id);
    let release!: (path: string) => void;
    f.file.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const id = f.window.requestShow('a', p.id);
    await vi.advanceTimersByTimeAsync(PRESENTATION_HOST_LIMITS.answerMs);
    expect(f.window.showOutcomes.get(id)).toBe('unavailable');
    release('/allowed/result.md');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sent.filter((message) => message.kind === 'present')).toHaveLength(1);
    expect(
      f.sent.filter((message) => message.kind === 'show-answer' && message.requestId === id),
    ).toHaveLength(1);
    f.host.disconnect();
  });
  it('keeps accepting requests past the identity bound without replaying an uncertain one', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.hold();
    const request = present();
    const signal = new AbortController().signal;
    const pending = f.host.execute('a', 'uncertain', request, signal);
    await vi.advanceTimersByTimeAsync(PRESENTATION_HOST_LIMITS.answerMs);
    expect((await pending).outcome.status).toBe('indeterminate');
    for (let n = 0; n < 4100; n++)
      expect((await f.run({ kind: 'list' })).outcome.status).toBe('verified');
    expect((await f.host.execute('a', 'uncertain', request, signal)).outcome.status).toBe(
      'indeterminate',
    );
    expect(f.sent.filter((command) => command.kind === 'present')).toHaveLength(1);
    f.host.disconnect();
  }, 20_000);
  it('reopens resource Show at its current version and preserves a comparison’s last placement', async () => {
    const f = fixture();
    const placement = { side: 'bottom' as const, direction: 'column' as const };
    const p = shown(
      await f.run({
        ...present(),
        placement,
        items: [
          { kind: 'browser', tabId: 'a-tab' },
          { kind: 'file', path: '/allowed/result.md' },
        ],
      }),
    );
    // The commands main sent, apart from its answers to the user's requests.
    const commands = () => f.sent.filter((message) => message.kind !== 'show-answer');
    const outcome = (requestId: string) => f.window.showOutcomes.get(requestId);
    f.window.close(p.id);
    const first = f.window.requestShowContent('a', { kind: 'browser', tabId: 'a-tab' });
    await vi.waitFor(() => {
      expect(outcome(first)).toBe('shown');
    });
    expect(commands()).toHaveLength(2);
    expect(commands()[1]).toMatchObject({
      kind: 'present',
      presentationId: p.id,
      version: 2,
      placement,
    });
    f.window.close(p.id);
    const again = f.window.requestShowContent('a', { kind: 'browser', tabId: 'a-tab' });
    await vi.waitFor(() => {
      expect(outcome(again)).toBe('shown');
    });
    expect(commands()).toHaveLength(3);
    expect(commands()[2]).toMatchObject({
      kind: 'present',
      presentationId: p.id,
      version: 4,
      placement,
    });
    const foreign = f.window.requestShowContent('b', { kind: 'browser', tabId: 'a-tab' });
    expect(outcome(foreign)).toBe('unavailable');
    expect(commands()).toHaveLength(3);
    const own = f.window.requestShowContent('b', { kind: 'browser', tabId: 'b-tab' });
    await vi.waitFor(() => {
      expect(outcome(own)).toBe('shown');
    });
    const presented = commands()[3];
    if (presented?.kind !== 'present') throw Error('No presentation');
    f.window.close(presented.presentationId);
    const reshown = f.window.requestShowContent('b', { kind: 'browser', tabId: 'b-tab' });
    await vi.waitFor(() => {
      expect(outcome(reshown)).toBe('shown');
    });
    expect(commands()[4]).toMatchObject({
      kind: 'present',
      presentationId: presented.presentationId,
      version: 2,
    });
  });
  it('reclaims only the owner’s oldest closed payloads under pressure and reports expired handles and full budgets', async () => {
    const f = fixture();
    const artifact = {
      kind: 'artifact' as const,
      artifact: {
        format: 'table' as const,
        title: 'Synthetic',
        columns: ['value'],
        rows: [['x'.repeat(2 * 1024 * 1024 - 256)]],
      },
    };
    const presentations = [];
    for (let n = 0; n < 16; n++)
      presentations.push(
        shown(await f.run({ ...present(`large-${String(n)}`), items: [artifact] })),
      );
    // All payloads are still open: no capacity is reclaimed and failure is a capacity outcome.
    expect((await f.run({ ...present('full'), items: [artifact] })).outcome).toMatchObject({
      code: 'limit-exceeded',
    });
    const first = presentations[0];
    const second = presentations[1];
    const third = presentations[2];
    if (!first || !second || !third) throw Error('Missing presentation');
    const oldest = first.items[0]?.content;
    const later = second.items[0]?.content;
    const open = third.items[0]?.content;
    if (oldest?.kind !== 'artifact' || later?.kind !== 'artifact' || open?.kind !== 'artifact')
      throw Error('No artifact');
    f.window.close(first.id);
    f.window.close(second.id);
    shown(await f.run({ ...present('new'), items: [artifact] }));
    expect(f.host.artifact(oldest.artifactId)).toBeNull();
    expect(f.host.artifact(later.artifactId)).not.toBeNull();
    expect(f.host.artifact(open.artifactId)).not.toBeNull();
    expect(
      (await f.run({ ...present('large-0', first.version + 1), items: [oldest] })).outcome,
    ).toMatchObject({ code: 'result-expired' });
    const showExpired = f.window.requestShow('a', first.id);
    await vi.waitFor(() => {
      expect(f.window.showOutcomes.get(showExpired)).toBe('expired');
    });
    // Cross-owner use of an expired handle does not reveal another owner's retained descriptor.
    expect((await f.run({ ...present('foreign'), items: [oldest] }, 'b')).outcome).toMatchObject({
      code: 'not-found',
    });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
    f.reload();
    expect(f.host.artifact(open.artifactId)).not.toBeNull();
    f.host.disconnect();
  }, 20_000);
  it('pins a reused artifact while another content check waits, even if its original presentation changes', async () => {
    const f = fixture();
    const oldPayload = { format: 'markdown' as const, title: 'First', text: 'First contents' };
    const first = shown(
      await f.run({ ...present(), items: [{ kind: 'artifact', artifact: oldPayload }] }),
    );
    const old = first.items[0]?.content;
    if (old?.kind !== 'artifact') throw Error('No artifact');
    let release!: (path: string) => void;
    const gate = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    f.file.mockImplementation((_owner, path) =>
      path.endsWith('/wait') ? gate : Promise.resolve(path),
    );
    const pending = f.run({
      ...present('shared'),
      items: [old, { kind: 'file', path: '/allowed/wait' }],
    });
    await vi.waitFor(() => {
      expect(f.file).toHaveBeenCalledWith('a', '/allowed/wait');
    });
    shown(
      await f.run({
        kind: 'update',
        presentationId: first.id,
        version: first.version,
        title: 'Second',
        items: [{ kind: 'artifact', artifact: { ...oldPayload, text: 'Second contents' } }],
      }),
    );
    release('/allowed/wait');
    expect(shown(await pending).items[0]?.content).toEqual(old);
    expect(f.host.artifact(old.artifactId)).toEqual(oldPayload);
  });
  it('releases superseded artifact payloads so repeated updates do not exhaust the cache', async () => {
    const f = fixture();
    const artifact = {
      kind: 'artifact' as const,
      artifact: {
        format: 'markdown' as const,
        title: 'Large result',
        text: 'x'.repeat(250 * 1024),
      },
    };
    let p = shown(await f.run({ ...present(), items: [artifact] }));
    const old = p.items[0]?.content;
    for (let n = 0; n < 140; n++)
      p = shown(
        await f.run({
          kind: 'update',
          presentationId: p.id,
          version: p.version,
          title: 'Current',
          items: [artifact],
        }),
      );
    if (old?.kind !== 'artifact') throw Error('No artifact');
    expect(f.host.artifact(old.artifactId)).toBeNull();
    const current = p.items[0]?.content;
    if (current?.kind !== 'artifact') throw Error('No current artifact');
    expect(f.host.artifact(current.artifactId)).toEqual(artifact.artifact);
  });
  it('keeps request tombstones after evicting bulky answers', async () => {
    const f = fixture();
    const request = present();
    await f.host.execute('a', 'remember', request, new AbortController().signal);
    for (let n = 0; n < PRESENTATION_HOST_LIMITS.resultsPerOwner; n++)
      await f.run({ kind: 'list' });
    expect(
      (await f.host.execute('a', 'remember', request, new AbortController().signal)).outcome,
    ).toMatchObject({ code: 'result-expired' });
    expect(f.sent.filter((m) => m.kind === 'present')).toHaveLength(1);
  });
  it('reuses identities, deduplicates requests and isolates owners before sending', async () => {
    const f = fixture();
    const request = present();
    const first = await f.host.execute('a', 'stable', request, new AbortController().signal);
    const p = shown(first);
    expect(await f.host.execute('a', 'stable', request, new AbortController().signal)).toEqual(
      first,
    );
    expect(f.sent).toHaveLength(1);
    expect(
      (
        await f.host.execute(
          'a',
          'stable',
          { ...request, title: 'Changed' },
          new AbortController().signal,
        )
      ).outcome,
    ).toMatchObject({ code: 'request-conflict' });
    expect(
      (await f.run({ kind: 'close', presentationId: p.id, version: p.version }, 'b')).outcome,
    ).toMatchObject({ code: 'wrong-owner' });
    expect(f.sent).toHaveLength(1);
    const updated = shown(await f.run(present('result', p.version)));
    expect(updated.id).toBe(p.id);
    expect(updated.version).toBe(p.version + 1);
    const list = await f.run({ kind: 'list' }, 'b');
    expect(list.outcome).toMatchObject({
      value: { presentations: [], sessionPanels: [{ owner: 'b' }] },
    });
  });
  it('retains user closes, returns current state on stale calls, and never reopens on update', async () => {
    const f = fixture();
    const p = shown(await f.run(present()));
    f.window.close(p.id);
    expect(f.notice).toHaveBeenLastCalledWith(
      'a',
      expect.objectContaining({
        presentation: {
          ...p,
          version: p.version + 1,
          items: [{ content: p.items[0]?.content, box: null }],
        },
      }),
    );
    const stale = await f.run({
      kind: 'arrange',
      presentationId: p.id,
      version: p.version,
      placement: DEFAULT_PLACEMENT,
    });
    expect(stale.outcome).toMatchObject({
      code: 'layout-conflict',
      detail: { current: { version: p.version + 1 } },
    });
    const changed = shown(
      await f.run({
        kind: 'update',
        presentationId: p.id,
        version: p.version + 1,
        title: 'Edited result',
        items: [{ kind: 'file', path: '/allowed/edited.md' }],
      }),
    );
    expect(changed.items[0]?.box).toBeNull();
    expect(shown(await f.run(present('result', changed.version))).items[0]?.box).not.toBeNull();
  });
  it('honors unsaved files and the renderer’s complete drag hold, including cancellation', async () => {
    const f = fixture();
    const p = shown(await f.run(present()));
    f.window.setUnsaved(p.id, 0, true);
    expect(
      (await f.run({ kind: 'close', presentationId: p.id, version: p.version })).outcome,
    ).toMatchObject({ code: 'needs-user-action', detail: { reason: 'unsaved-changes' } });
    f.window.setUnsaved(p.id, 0, false);
    f.window.startDrag();
    const pending = f.run({
      kind: 'arrange',
      presentationId: p.id,
      version: p.version,
      placement: DEFAULT_PLACEMENT,
    });
    await Promise.resolve();
    f.window.advance(PRESENTATION_HOLD_MS);
    expect((await pending).outcome).toMatchObject({ code: 'busy' });
    const controller = new AbortController();
    const cancelled = f.run(
      { kind: 'close', presentationId: p.id, version: p.version },
      'a',
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    expect((await cancelled).outcome.status).toBe('cancelled-before-dispatch');
    f.window.endDrag();
  });
  it('returns the current state when a user close defeats a held present', async () => {
    const f = fixture();
    const p = shown(await f.run(present()));
    f.window.startDrag();
    const pending = f.run(present('result', p.version));
    await vi.waitFor(() => {
      expect(f.sent).toHaveLength(2);
    });
    f.window.close(p.id);
    f.window.endDrag();
    expect((await pending).outcome).toMatchObject({
      code: 'layout-conflict',
      detail: { current: { version: p.version + 1, items: [{ box: null }] } },
    });
  });
  it('invalidates old acknowledgements on reload without claiming that a lost panel is shown', async () => {
    const f = fixture();
    const p = shown(await f.run(present()));
    f.hold();
    const pending = f.run({
      kind: 'update',
      presentationId: p.id,
      version: p.version,
      title: 'New',
      items: [{ kind: 'file', path: '/allowed/new.md' }],
    });
    await vi.waitFor(() => {
      expect(f.reports).toHaveLength(1);
    });
    f.reload();
    expect((await pending).outcome.status).toBe('indeterminate');
    expect(f.host.receive(f.reports[0])).toBe(false);
    const list = await f.run({ kind: 'list' });
    expect(list.outcome).toMatchObject({
      value: { presentations: [{ id: p.id, items: [{ box: null }] }] },
    });
    f.hold(false);
    expect(shown(await f.run(present('result', p.version + 1))).items[0]?.box).not.toBeNull();
  });
  it('retains uncertainty after timeout and accepts a late acknowledgement without replaying', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.hold();
    const pending = f.run(present());
    await vi.advanceTimersByTimeAsync(PRESENTATION_HOST_LIMITS.answerMs);
    expect((await pending).outcome).toMatchObject({ status: 'indeterminate', reason: 'timeout' });
    expect(f.sent.filter((m) => m.kind === 'present')).toHaveLength(1);
    expect(f.host.receive(f.reports[0])).toBe(true);
    expect((await f.run({ kind: 'list' })).outcome).toMatchObject({
      value: { unresolved: [], presentations: [{ title: 'Fixture' }] },
    });
    expect(f.notice).toHaveBeenCalled();
  });
  it('does not call an applied command undispatched when the user closes its panel before the answer arrives', async () => {
    const f = fixture();
    const p = shown(await f.run(present()));
    f.hold();
    const pending = f.run({
      kind: 'update',
      presentationId: p.id,
      version: p.version,
      title: 'Updated',
      items: [{ kind: 'file', path: '/allowed/updated.md' }],
    });
    await vi.waitFor(() => {
      expect(f.reports).toHaveLength(1);
    });
    f.window.close(p.id);
    f.host.receive(f.reports[0]);
    expect((await pending).outcome).toMatchObject({
      status: 'indeterminate',
      reason: 'presentation-race',
    });
    expect(f.notice.mock.calls.at(-1)?.[1].presentation.items[0]?.box).toBeNull();
  });
  it('checks file/resource access and serves artifacts before their acknowledgement, scoped by owner', async () => {
    const f = fixture();
    expect(
      (await f.run({ ...present(), items: [{ kind: 'file', path: '/outside/a.md' }] })).outcome,
    ).toMatchObject({ code: 'sandbox-denied' });
    expect(
      (await f.run({ ...present(), items: [{ kind: 'browser', tabId: 'b-tab' }] })).outcome,
    ).toMatchObject({ code: 'not-found' });
    f.hold();
    const artifact = { format: 'markdown' as const, title: 'Result', text: '# Synthetic' };
    const pending = f.run({ ...present(), items: [{ kind: 'artifact', artifact }] });
    await vi.waitFor(() => {
      expect(f.sent).toHaveLength(1);
    });
    const command = f.sent[0];
    if (command?.kind !== 'present') throw Error('No present');
    const item = command.items[0];
    if (item?.kind !== 'artifact') throw Error('No artifact');
    expect(f.host.artifact(item.artifactId)).toEqual(artifact);
    f.host.receive(f.reports[0]);
    await pending;
    f.hold(false);
    expect((await f.run({ ...present(), items: [item] }, 'b')).outcome).toMatchObject({
      code: 'not-found',
    });
    f.owners.delete('a');
    f.host.removeOwner('a');
    expect(f.host.artifact(item.artifactId)).toBeNull();
  });
  it('routes the user’s Show through a new versioned command and retries notice backpressure', async () => {
    const f = fixture();
    const p = shown(await f.run(present()));
    f.notice.mockReturnValue({ status: 'refused', code: 'limit-exceeded', dispatched: false });
    f.window.close(p.id);
    f.notice.mockReturnValue({ status: 'verified', value: null });
    f.host.flushNotices();
    expect(f.notice.mock.calls.at(-1)?.[1].presentation.version).toBe(p.version + 1);
    const commands = () => f.sent.filter((message) => message.kind !== 'show-answer');
    const shownAgain = f.window.requestShow('a', p.id);
    await vi.waitFor(() => {
      expect(f.window.showOutcomes.get(shownAgain)).toBe('shown');
    });
    expect(commands()).toHaveLength(2);
    expect(commands()[1]).toMatchObject({ kind: 'present', version: p.version + 1 });
    const resource = f.window.requestShowContent('b', { kind: 'browser', tabId: 'b-tab' });
    await vi.waitFor(() => {
      expect(f.window.showOutcomes.get(resource)).toBe('shown');
    });
    expect(commands()[2]).toMatchObject({ owner: 'b', title: 'Synthetic page' });
    expect(f.window.showOutcomes.get(f.window.requestShow('a', 'unknown'))).toBe('unavailable');
  });
  it('never replaces newer content with an older acknowledgement after timeout recovery', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const p = shown(await f.run(present()));
    f.hold();
    const old = f.run({
      kind: 'update',
      presentationId: p.id,
      version: p.version,
      title: 'Old update',
      items: [{ kind: 'file', path: '/allowed/old.md' }],
    });
    await vi.advanceTimersByTimeAsync(PRESENTATION_HOST_LIMITS.answerMs);
    expect((await old).outcome.status).toBe('indeterminate');
    f.hold(false);
    expect((await f.run(present('result', p.version))).outcome).toMatchObject({
      code: 'layout-conflict',
    });
    const fresh = shown(
      await f.run({ ...present('result', p.version + 1), title: 'Newest content' }),
    );
    f.host.receive(f.reports[0]);
    expect((await f.run({ kind: 'list' })).outcome).toMatchObject({
      value: { presentations: [{ title: 'Newest content', version: fresh.version }] },
    });
  });
  it('can exceed the retained-descriptor bound without forgetting an open presentation', async () => {
    const f = fixture();
    const kept = shown(await f.run(present('kept')));
    for (let n = 0; n < PRESENTATION_HOST_LIMITS.presentations + 1; n++) {
      const p = shown(await f.run(present(`closed-${String(n)}`)));
      f.window.close(p.id);
    }
    const updated = shown(
      await f.run({
        kind: 'update',
        presentationId: kept.id,
        version: kept.version,
        title: 'Still open',
        items: [{ kind: 'file', path: '/allowed/kept.md' }],
      }),
    );
    expect(updated.items[0]?.box).not.toBeNull();
  });
});
