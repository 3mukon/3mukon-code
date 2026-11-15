import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLACEMENT,
  PRESENTATION_HOLD_MS,
  type PanelBox,
  type PresentationAnswer,
  type PresentationCommand,
  type PresentationRendererMessage,
  type PresentationReport,
  type PresentationState,
  type PresentedContent,
} from './presentation';
import { FAKE_SESSION_BOX, FakePresentationWindow } from './presentation-fake';

const owner = 'session-1';
const markdown: PresentedContent = { kind: 'artifact', artifactId: 'artifact-1' };
const table: PresentedContent = { kind: 'artifact', artifactId: 'artifact-2' };
const page: PresentedContent = { kind: 'browser', tabId: 'tab-1' };

// Where the fake lays out a presentation's open panels: side by side across the area's right half.
const whole: PanelBox = { x: 0.5, y: 0, width: 0.5, height: 1 };
const first: PanelBox = { x: 0.5, y: 0, width: 0.25, height: 1 };
const second: PanelBox = { x: 0.75, y: 0, width: 0.25, height: 1 };

// A window and what it sent main, with what main sends it. As main would, each command carries its
// own ID, the page's epoch and the latest version of the presentation the window told of, unless the
// test says otherwise.
function setUp(sessionsShown: string[] = [owner]) {
  const sent: PresentationRendererMessage[] = [];
  const window = new FakePresentationWindow((message) => sent.push(message), sessionsShown);
  let commands = 0;
  const latestVersion = (presentationId: string): number => {
    for (let index = sent.length - 1; index >= 0; index -= 1) {
      const message = sent[index];
      const states: (PresentationState | null)[] =
        message === undefined
          ? []
          : message.kind === 'snapshot'
            ? message.presentations
            : 'state' in message
              ? [message.state]
              : [];
      const state = states.find((candidate) => candidate?.presentationId === presentationId);
      if (state) return state.version;
    }
    return 0;
  };
  const basis = (presentationId: string, facts: Partial<Facts>) => ({
    commandId: `command-${String(++commands)}`,
    epoch: facts.epoch ?? window.epoch,
    owner: facts.owner ?? owner,
    presentationId,
    version: facts.version ?? latestVersion(presentationId),
  });
  const answerTo = (commandId: string): PresentationAnswer => {
    const answer = sent.findLast(
      (message): message is PresentationAnswer =>
        'commandId' in message && message.commandId === commandId,
    );
    if (answer === undefined) throw new Error(`no answer to ${commandId}`);
    return answer;
  };
  const send = (command: PresentationCommand): PresentationAnswer => {
    window.receive(command);
    return answerTo(command.commandId);
  };
  const changes = () => sent.filter(isChange);
  return {
    window,
    sent,
    answerTo,
    send,
    changes,
    present: (
      presentationId: string,
      items: PresentedContent[] = [markdown],
      facts: Partial<Facts> = {},
    ): PresentationCommand => ({
      ...basis(presentationId, facts),
      kind: 'present',
      title: 'Pricing compared',
      items,
      placement: DEFAULT_PLACEMENT,
    }),
    update: (
      presentationId: string,
      items: PresentedContent[] = [table],
      facts: Partial<Facts> = {},
    ): PresentationCommand => ({
      ...basis(presentationId, facts),
      kind: 'update',
      title: 'Pricing compared again',
      items,
    }),
    arrange: (presentationId: string, facts: Partial<Facts> = {}): PresentationCommand => ({
      ...basis(presentationId, facts),
      kind: 'arrange',
      placement: { side: 'bottom', direction: 'column' },
    }),
    close: (presentationId: string, facts: Partial<Facts> = {}): PresentationCommand => ({
      ...basis(presentationId, facts),
      kind: 'close',
    }),
  };
}

interface Facts {
  epoch: string;
  owner: string;
  version: number;
}

type Change = Extract<PresentationReport, { kind: 'changed' }>;

const isChange = (message: PresentationRendererMessage): message is Change =>
  message.kind === 'changed';

const applied = (answer: PresentationAnswer) => {
  if (answer.kind !== 'applied') throw new Error(`not applied: ${JSON.stringify(answer)}`);
  return answer;
};

// Which of an applied command's presentation's panels are open: those with a box.
const opened = (answer: PresentationAnswer) =>
  applied(answer).state.boxes.map((box) => box !== null);

const refusal = (answer: PresentationAnswer) => (answer.kind === 'refused' ? answer.code : null);

describe('the fake presentation window, which answers as the window does', () => {
  it("starts a page with a snapshot of its epoch and the sessions' panels, having no presentation, and sends another as those panels change", () => {
    const { window, sent } = setUp();
    expect(sent).toEqual([
      {
        kind: 'snapshot',
        epoch: window.epoch,
        sessionPanels: [{ owner, box: FAKE_SESSION_BOX }],
        presentations: [],
      },
    ]);
    window.hideSession(owner);
    expect(sent.at(-1)).toMatchObject({ kind: 'snapshot', sessionPanels: [] });
  });

  it('opens a presentation and answers with its state, version and where its panels lie, which is all it sends', () => {
    const { window, sent, send, present } = setUp();
    const command = present('presentation-1');
    expect(send(command)).toEqual({
      kind: 'applied',
      commandId: command.commandId,
      epoch: window.epoch,
      state: { presentationId: 'presentation-1', owner, version: 1, boxes: [whole] },
    });
    expect(sent).toHaveLength(2);
  });

  it('opens a presentation whether or not its session has a panel open, which only decides where', () => {
    const { send, present } = setUp([]);
    expect(opened(send(present('presentation-1')))).toEqual([true]);
  });

  it('answers a repeated command ID as before, changing nothing, and refuses it with other content', () => {
    const { window, sent, send, present } = setUp();
    const command = present('presentation-1');
    const answer = send(command);
    const count = sent.length;
    window.receive(command);
    expect(sent.slice(count)).toEqual([answer]);
    expect(refusal(send({ ...command, title: 'Something else' } as PresentationCommand))).toBe(
      'command-conflict',
    );
    expect(applied(send(present('presentation-1'))).state.version).toBe(2);
  });

  it("refuses a command whose version is not the presentation's, with its state, so that the agent fetches it and tries again", () => {
    const { window, send, present, update, changes } = setUp();
    send(present('presentation-1', [markdown, page]));
    window.move('presentation-1');
    expect(changes().at(-1)).toMatchObject({ state: { version: 2 } });
    expect(send(update('presentation-1', [table, page], { version: 1 }))).toMatchObject({
      kind: 'refused',
      code: 'presentation-changed',
      state: { version: 2, boxes: [first, second] },
    });
    expect(applied(send(update('presentation-1', [table, page]))).state.version).toBe(3);
  });

  it('updates a presentation in place, and refuses to update one it does not have', () => {
    const { send, present, update } = setUp();
    send(present('presentation-1'));
    expect(applied(send(update('presentation-1'))).state).toMatchObject({
      version: 2,
      boxes: [whole],
    });
    expect(refusal(send(update('presentation-2')))).toBe('presentation-unknown');
  });

  it("tells main of the user's close, refuses what was sent before it, updates what the closed panel shows without opening it, and lets a present reopen it", () => {
    const { window, sent, send, present, update } = setUp();
    send(present('presentation-1'));
    const before = update('presentation-1');
    window.close('presentation-1');
    expect(sent.at(-1)).toEqual({
      kind: 'changed',
      epoch: window.epoch,
      state: { presentationId: 'presentation-1', owner, version: 2, boxes: [null] },
    });
    expect(refusal(send(before))).toBe('presentation-changed');
    expect(applied(send(update('presentation-1', [table]))).state).toMatchObject({
      version: 3,
      boxes: [null],
    });
    expect(applied(send(present('presentation-1'))).state).toMatchObject({
      version: 4,
      boxes: [whole],
    });
  });

  it("changes only what a comparison's panels show with an update, each staying open or closed whatever it shows, and reopens them with a present", () => {
    const { window, sent, send, present, update } = setUp();
    send(present('presentation-1', [markdown, page]));
    window.close('presentation-1', [1]);
    expect(sent.at(-1)).toMatchObject({ kind: 'changed', state: { boxes: [whole, null] } });
    expect(opened(send(update('presentation-1', [markdown, table])))).toEqual([true, false]);
    expect(opened(send(update('presentation-1', [table, markdown])))).toEqual([true, false]);
    expect(applied(send(present('presentation-1', [table, markdown]))).state.boxes).toEqual([
      first,
      second,
    ]);
  });

  it("refuses an update that does not give one item for each of the presentation's panels, whose number only a present changes", () => {
    const { send, present, update } = setUp();
    send(present('presentation-1', [markdown, page]));
    expect(refusal(send(update('presentation-1', [markdown])))).toBe('item-count-mismatch');
    expect(refusal(send(update('presentation-1', [markdown, page, table])))).toBe(
      'item-count-mismatch',
    );
    expect(opened(send(present('presentation-1', [markdown, page, table])))).toEqual([
      true,
      true,
      true,
    ]);
    expect(opened(send(update('presentation-1', [table, page, markdown])))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("tells main when the user moves or resizes a presentation's panels, or the layout around them changes, with where they lie", () => {
    const { window, sent, send, present, arrange, changes } = setUp();
    send(present('presentation-1', [markdown, table]));
    const swapped = [second, first];
    window.move('presentation-1', swapped);
    expect(sent.at(-1)).toEqual({
      kind: 'changed',
      epoch: window.epoch,
      state: { presentationId: 'presentation-1', owner, version: 2, boxes: swapped },
    });
    const shorter = [
      { ...second, height: 0.5 },
      { ...first, height: 0.5 },
    ];
    window.move('presentation-1', shorter);
    expect(changes().at(-1)).toMatchObject({ state: { version: 3, boxes: shorter } });
    expect(applied(send(arrange('presentation-1'))).state).toMatchObject({
      version: 4,
      boxes: [first, second],
    });
    window.close('presentation-1');
    const count = sent.length;
    window.move('presentation-1');
    expect(sent).toHaveLength(count);
  });

  it('holds a command during a drag until the drop, cancels one main withdraws, and refuses one held too long', () => {
    const { window, sent, answerTo, present } = setUp();
    const held = present('presentation-1');
    window.startDrag();
    window.receive(held);
    window.receive(held);
    expect(sent).toHaveLength(1);
    window.endDrag();
    expect(opened(answerTo(held.commandId))).toEqual([true]);
    expect(sent.filter((message) => 'commandId' in message)).toHaveLength(1);

    const withdrawn = present('presentation-2');
    window.startDrag();
    window.receive(withdrawn);
    window.receive({ kind: 'cancel', commandId: withdrawn.commandId, epoch: window.epoch });
    window.endDrag();
    expect(answerTo(withdrawn.commandId)).toEqual({
      kind: 'cancelled',
      commandId: withdrawn.commandId,
      epoch: window.epoch,
    });
    window.receive(withdrawn);
    expect(answerTo(withdrawn.commandId).kind).toBe('cancelled');

    const late = present('presentation-3');
    window.startDrag();
    window.receive(late);
    window.advance(PRESENTATION_HOLD_MS - 1);
    expect(() => answerTo(late.commandId)).toThrow();
    window.advance(1);
    expect(refusal(answerTo(late.commandId))).toBe('busy');
    window.endDrag();
    expect(sent.at(-1)).toMatchObject({ kind: 'refused', code: 'busy' });
  });

  it('applies an update at once during a drag, as it places no panel, while a present waits for the drop', () => {
    const { window, answerTo, send, present, update } = setUp();
    send(present('presentation-1'));
    window.startDrag();
    expect(applied(send(update('presentation-1'))).state.version).toBe(2);
    const waiting = present('presentation-2');
    window.receive(waiting);
    expect(() => answerTo(waiting.commandId)).toThrow();
    window.endDrag();
    expect(opened(answerTo(waiting.commandId))).toEqual([true]);
  });

  it('answers a repeat of a command it applied at once during a drag, and never turns that answer into busy', () => {
    const { window, sent, answerTo, send, present } = setUp();
    const command = present('presentation-1');
    const answer = send(command);
    window.startDrag();
    const count = sent.length;
    window.receive(command);
    expect(sent.slice(count)).toEqual([answer]);
    window.advance(PRESENTATION_HOLD_MS);
    window.endDrag();
    expect(sent.slice(count)).toEqual([answer]);
    window.receive(command);
    expect(answerTo(command.commandId)).toEqual(answer);
  });

  it('answers a repeat of a command it cancelled as cancelled at once during a drag, holding nothing', () => {
    const { window, sent, present } = setUp();
    const command = present('presentation-1');
    window.startDrag();
    window.receive(command);
    window.receive({ kind: 'cancel', commandId: command.commandId, epoch: window.epoch });
    const count = sent.length;
    window.receive(command);
    window.advance(PRESENTATION_HOLD_MS);
    window.endDrag();
    expect(sent.slice(count)).toEqual([
      { kind: 'cancelled', commandId: command.commandId, epoch: window.epoch },
    ]);
  });

  it('refuses a command ID it holds when it comes again with other content, and goes on holding the first', () => {
    const { window, sent, present } = setUp();
    const command = present('presentation-1');
    const changed = { ...command, title: 'Something else' } as PresentationCommand;
    window.startDrag();
    window.receive(command);
    window.receive(changed);
    expect(sent.at(-1)).toMatchObject({
      kind: 'refused',
      commandId: command.commandId,
      code: 'command-conflict',
    });
    window.endDrag();
    expect(applied(sent.at(-1) as PresentationAnswer).commandId).toBe(command.commandId);
    window.receive(changed);
    expect(sent.at(-1)).toMatchObject({ kind: 'refused', code: 'command-conflict' });
  });

  it('answers a cancel for a command it has applied with the answer it gave', () => {
    const { window, sent, send, present } = setUp();
    const command = present('presentation-1');
    const answer = send(command);
    window.receive({ kind: 'cancel', commandId: command.commandId, epoch: window.epoch });
    expect(sent.at(-1)).toEqual(answer);
  });

  it('never closes, or shows anything else in, a file panel holding unsaved changes', () => {
    const { window, send, present, update, close } = setUp();
    const file: PresentedContent = { kind: 'file', path: '/work/notes.md' };
    send(present('presentation-1', [file]));
    window.setUnsaved('presentation-1', 0, true);
    expect(refusal(send(close('presentation-1')))).toBe('unsaved-changes');
    expect(
      refusal(send(update('presentation-1', [{ kind: 'file', path: '/work/other.md' }]))),
    ).toBe('unsaved-changes');
    expect(opened(send(update('presentation-1', [file])))).toEqual([true]);
    expect(refusal(send(present('presentation-1', [table, file])))).toBe('unsaved-changes');
    expect(opened(send(present('presentation-1', [file, table])))).toEqual([true, true]);
    expect(opened(send(update('presentation-1', [file, markdown])))).toEqual([true, true]);
    expect(refusal(send(update('presentation-1', [markdown, file])))).toBe('unsaved-changes');
    expect(opened(send(present('presentation-1', [file])))).toEqual([true]);
    expect(refusal(send(close('presentation-1')))).toBe('unsaved-changes');
  });

  it("takes the place of the session's presentation presented last where the area has no room, reporting that one's latest state, unless it holds unsaved changes", () => {
    const { window, sent, send, present, update, changes } = setUp();
    send(present('presentation-1'));
    send(present('presentation-2'));
    window.setRoom(owner, false);
    send(update('presentation-1'));
    const replacing = present('presentation-3');
    expect(opened(send(replacing))).toEqual([true]);
    expect(sent.slice(-2)).toEqual([
      expect.objectContaining({ kind: 'applied', commandId: replacing.commandId }),
      {
        kind: 'changed',
        epoch: window.epoch,
        state: { presentationId: 'presentation-2', owner, version: 2, boxes: [null] },
      },
    ]);
    expect(changes().filter((change) => change.state.presentationId !== 'presentation-2')).toEqual(
      [],
    );
    expect(opened(send(update('presentation-2')))).toEqual([false]);
    window.setUnsaved('presentation-3', 0, true);
    const beside = present('presentation-4');
    send(beside);
    expect(sent.at(-1)).toMatchObject({ kind: 'applied', commandId: beside.commandId });
  });

  it("refuses a present sent before the user's close of a presentation another has since taken the place of, and goes on taking its updates", () => {
    const { window, answerTo, send, present, update, changes } = setUp();
    send(present('presentation-1', [markdown, table]));
    window.setRoom(owner, false);
    const replacing = present('presentation-2', [page]);
    const older = present('presentation-1', [markdown, table]);
    window.startDrag();
    window.receive(replacing);
    window.receive(older);
    window.close('presentation-1', [1]);
    window.endDrag();
    expect(opened(answerTo(replacing.commandId))).toEqual([true]);
    expect(changes().at(-1)).toMatchObject({
      state: { presentationId: 'presentation-1', boxes: [null, null] },
    });
    expect(refusal(answerTo(older.commandId))).toBe('presentation-changed');
    expect(opened(send(update('presentation-1', [markdown, page])))).toEqual([false, false]);
  });

  it("starts a new page on a reload, which refuses the old page's commands and counts versions on from main's", () => {
    const { window, sent, send, present, update } = setUp();
    const oldEpoch = window.epoch;
    send(present('presentation-1'));
    window.reload();
    expect(sent.at(-1)).toEqual({
      kind: 'snapshot',
      epoch: window.epoch,
      sessionPanels: [],
      presentations: [],
    });
    const stale = send(present('presentation-1', [markdown], { epoch: oldEpoch }));
    expect(stale).toMatchObject({ kind: 'refused', code: 'stale-epoch', epoch: window.epoch });
    expect(refusal(send(update('presentation-1')))).toBe('presentation-unknown');
    expect(applied(send(present('presentation-1'))).state.version).toBe(2);
    window.close('presentation-1');
    expect(sent.at(-1)).toMatchObject({ kind: 'changed', state: { version: 3 } });
  });

  it("passes on the user's request to see a presentation again, or a tab or application the session uses that no presentation shows", () => {
    const { window, sent } = setUp();
    window.requestShow(owner, 'presentation-1');
    expect(sent.at(-1)).toEqual({
      kind: 'show',
      epoch: window.epoch,
      owner,
      presentationId: 'presentation-1',
    });
    window.requestShowContent(owner, { kind: 'computer', targetId: 'target-1' });
    expect(sent.at(-1)).toEqual({
      kind: 'show',
      epoch: window.epoch,
      owner,
      content: { kind: 'computer', targetId: 'target-1' },
    });
  });

  it("refuses another session's command for a presentation, without describing it, and a malformed one", () => {
    const { send, present, update } = setUp();
    send(present('presentation-1'));
    const answer = send(update('presentation-1', [table], { owner: 'session-2' }));
    expect(answer).toMatchObject({ kind: 'refused', code: 'wrong-owner', state: null });
    expect(refusal(send(present('presentation-2', [])))).toBe('invalid-command');
  });

  it("closes a presentation at its agent's request, reporting no change of its own, and goes on taking commands for it", () => {
    const { window, send, present, update, close, changes } = setUp();
    send(present('presentation-1', [markdown, table]));
    window.close('presentation-1', [1]);
    const reported = changes().length;
    expect(applied(send(close('presentation-1'))).state).toMatchObject({
      version: 3,
      boxes: [null, null],
    });
    expect(changes()).toHaveLength(reported);
    expect(opened(send(update('presentation-1', [markdown, page])))).toEqual([false, false]);
    expect(opened(send(present('presentation-1')))).toEqual([true]);
  });
});
