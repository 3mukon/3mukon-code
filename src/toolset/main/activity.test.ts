import { describe, expect, it } from 'vitest';
import type { AutomationEvent, Frame, PresentationNotice } from '../../sessions/shared/automation';
import { Activity } from './activity';

const notice = (version: number): PresentationNotice => ({
  noticeId: `state-${String(version)}`,
  owner: 'session',
  reuseKey: 'result',
  presentation: {
    id: 'presentation',
    title: 'Synthetic result',
    version,
    items: [{ content: { kind: 'artifact', artifactId: 'result' }, box: null }],
  },
});
const verified = { status: 'verified', value: null } as const;

describe('retained activity and latest presentation delivery', () => {
  it('retires the oldest unanswered delivery as failed and acknowledges only selected prepared versions', () => {
    const activity = new Activity(
      'session',
      () => undefined,
      () => 1,
    );
    activity.presentationChanged(notice(1));
    const oldest = activity.prepareTurn();
    for (let n = 0; n < 32; n++) activity.prepareTurn();
    activity.finishTurnDelivery(oldest.id, true);
    expect(activity.pendingNotices()).toEqual([notice(1)]);
    const current = activity.prepareTurn();
    activity.finishTurnDelivery(current.id, true, []);
    expect(activity.pendingNotices()).toEqual([notice(1)]);
    const older = activity.prepareTurn();
    activity.presentationChanged(notice(2));
    activity.finishTurnDelivery(older.id, true, [notice(2)]);
    // An acknowledged merged block cannot expand an old token's authority to the newer version.
    expect(activity.pendingNotices()).toEqual([notice(2)]);
    const latest = activity.prepareTurn();
    activity.finishTurnDelivery(latest.id, true, [notice(2)]);
    expect(activity.pendingNotices()).toEqual([]);
  });
  it('batches large notice sets within the JSON budget and retires only the delivered batch', () => {
    const activity = new Activity(
      'session',
      () => undefined,
      () => 1,
    );
    for (let n = 0; n < 80; n++) {
      const next = notice(1);
      next.noticeId = `n${String(n)}`;
      next.reuseKey = next.noticeId;
      next.presentation.id = next.noticeId;
      next.presentation.items = [
        { content: { kind: 'file', path: `/${'x'.repeat(3000)}` }, box: null },
      ];
      expect(activity.presentationChanged(next).status).toBe('verified');
    }
    const delivery = activity.prepareTurn();
    expect(Buffer.byteLength(JSON.stringify(delivery.notices))).toBeLessThan(64 * 1024);
    expect(delivery.notices.length).toBeLessThan(80);
    activity.finishTurnDelivery(delivery.id, true);
    expect(activity.pendingNotices()).toHaveLength(80 - delivery.notices.length);
    const call = activity.start(1, 'turn', 'panel_list', 'panel');
    const result = activity.settle(call.callId, {
      status: 'verified',
      value: 'x'.repeat(32 * 1024),
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
    expect(result.presentationNotices.length).toBeGreaterThan(0);
    const remaining = activity.pendingNotices().length;
    activity.link({
      callId: call.callId,
      sessionId: 'session',
      turnId: 'turn',
      accessGeneration: 1,
      toolName: 'panel_list',
      providerToolId: 'native',
    });
    expect(activity.pendingNotices()).toHaveLength(remaining - result.presentationNotices.length);
  });
  it('keeps accepting notices beyond the receipt bound, evicting least recently changed delivered states only', () => {
    const activity = new Activity(
      'session',
      () => undefined,
      () => 1,
    );
    activity.presentationChanged(notice(1));
    const renewed = {
      ...notice(2),
      noticeId: 'renewed-result-0',
      reuseKey: 'result-0',
      presentation: { ...notice(2).presentation, id: 'presentation-0' },
    };
    for (let index = 0; index < 4100; index++) {
      const next = notice(1);
      next.noticeId = `notice-${String(index)}`;
      next.reuseKey = `result-${String(index)}`;
      next.presentation.id = `presentation-${String(index)}`;
      expect(activity.presentationChanged(next).status).toBe('verified');
      if (index === 2048) expect(activity.presentationChanged(renewed).status).toBe('verified');
      // Keep the oldest presentation pending at a newer version than the delivery being accepted.
      const delivery = activity.prepareTurn();
      activity.presentationChanged(notice(index + 2));
      activity.finishTurnDelivery(delivery.id, true);
    }
    expect(activity.pendingNotices()).toEqual([notice(4101)]);
    activity.presentationChanged(renewed);
    expect(activity.pendingNotices()).toEqual([notice(4101)]);
    const evicted = notice(1);
    evicted.noticeId = 'notice-1';
    evicted.reuseKey = 'result-1';
    evicted.presentation.id = 'presentation-1';
    activity.presentationChanged(evicted);
    expect(activity.pendingNotices()).toContainEqual(evicted);
  });
  it('coalesces versions without letting an older accepted turn erase new state or replay delivered state', () => {
    const events: AutomationEvent[] = [];
    const activity = new Activity(
      'session',
      (event) => events.push(event),
      () => 1,
    );
    expect(activity.presentationChanged(notice(1))).toEqual(verified);
    const older = activity.prepareTurn();
    activity.presentationChanged(notice(2));
    activity.finishTurnDelivery(older.id, true);
    expect(activity.pendingNotices()).toEqual([notice(2)]);
    expect(events.at(-1)).toEqual({ kind: 'presentation-notices', notices: [notice(2)] });
    const newer = activity.prepareTurn();
    activity.finishTurnDelivery(newer.id, true);
    expect(events.at(-1)).toEqual({ kind: 'presentation-notices', notices: [] });
    const count = events.length;
    activity.presentationChanged(notice(2));
    activity.presentationChanged(notice(1));
    expect(activity.pendingNotices()).toEqual([]);
    expect(events).toHaveLength(count);
    expect(
      activity.presentationChanged({ ...notice(2), reuseKey: 'another-result' }),
    ).toMatchObject({ code: 'request-conflict' });
    expect(activity.presentationChanged({ ...notice(3), owner: 'other-session' })).toMatchObject({
      code: 'wrong-owner',
    });
  });

  it('keeps capture metadata after image eviction and emits no base64 in state changes', () => {
    const events: AutomationEvent[] = [];
    const activity = new Activity(
      'session',
      (event) => events.push(event),
      () => 1,
    );
    // Synthetic bytes exercise retention only; broker tests separately validate actual PNG frames.
    const frame: Frame = {
      target: { id: 'tab', kind: 'browser-tab', generation: 1 },
      observationId: 'capture',
      documentGeneration: 1,
      geometryGeneration: 1,
      capturedAt: 1,
      image: { mediaType: 'image/png', data: 'A'.repeat(6 * 1024 * 1024) },
      imageSize: { width: 1, height: 1 },
      viewport: { x: 0, y: 0, width: 1, height: 1 },
      units: 'css-pixels',
      imageToViewport: [1, 0, 0, 1, 0, 0],
    };
    const first = activity.start(1, 'turn', 'capture', 'browser');
    activity.settle(first.callId, verified, [frame]);
    expect(activity.frames(first.callId)).toEqual({ status: 'verified', value: [frame] });
    for (let index = 0; index < 2; index++) {
      const next = activity.start(1, 'turn', 'capture', 'browser');
      activity.settle(next.callId, verified, [
        { ...frame, observationId: `capture-${String(index)}` },
      ]);
    }
    expect(activity.frames(first.callId)).toMatchObject({
      status: 'refused',
      code: 'result-expired',
    });
    expect(activity.get(first.callId)).toMatchObject({
      framesState: 'evicted',
      frames: [{ observationId: 'capture', mediaType: 'image/png', capturedAt: 1 }],
    });
    expect(JSON.stringify(events)).not.toContain('"image":');
    expect(JSON.stringify(activity.list()).length).toBeLessThan(10_000);
  });

  it('reports record eviction explicitly so a subscribed activity agrees with a fresh snapshot', () => {
    const events: AutomationEvent[] = [];
    const activity = new Activity(
      'session',
      (event) => events.push(event),
      () => 1,
    );
    const first = activity.start(1, 'turn', 'present', 'panel');
    activity.settle(first.callId, verified);
    for (let index = 0; index < 256; index++) {
      const call = activity.start(1, 'turn', 'present', 'panel');
      activity.settle(call.callId, verified);
    }
    expect(activity.get(first.callId)).toBeUndefined();
    expect(activity.frames(first.callId)).toMatchObject({ code: 'not-found' });
    expect(events).toContainEqual({ kind: 'tool-call-removed', callId: first.callId });
    expect(activity.list()).toHaveLength(256);
  });
});
