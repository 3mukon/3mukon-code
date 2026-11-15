import {
  PRESENTATION_HOLD_MS,
  commandWithinLimits,
  sameContent,
  type PanelBox,
  type Placement,
  type PresentationAnswer,
  type PresentationCancel,
  type PresentationCommand,
  type PresentationHostMessage,
  type PresentationRefusal,
  type PresentationReport,
  type PresentationSnapshot,
  type PresentationState,
  type PresentedContent,
  type SessionPanel,
} from './presentation';

// The window's rules for main's presentation messages, apart from the layout that carries them out:
// which commands apply, and when, what each does to its presentation, and the answers and reports
// that follow. The panel area keeps a ledger for each page, and so does the fake window that main's
// tests use, so that the fake answers as the window does.

// What the layout tells the rules as a command arrives.
export interface AreaFacts {
  // Whether the user is dragging, during which commands that would place panels wait for the drop.
  dragging: boolean;
  // Whether one of a presentation's panels, by its place, holds unsaved changes.
  unsaved(presentationId: string, item: number): boolean;
}

// Where the layout has a presentation's panels, in the order of its items, given which are open: a
// box for every open one.
export type BoxesOf = (
  presentationId: string,
  open: readonly boolean[],
) => readonly (PanelBox | null)[];

// What a command asks of the layout. open shows a presentation none of whose panels is open, every
// panel open, where its placement says, or in place of its session's presentation presented last
// where the area has no room for both. change makes a presentation's panels, in place, the items
// given, in order: each shows its content where it is open, and the panels past them close. arrange
// places its open panels again; close closes them.
export type PresentationPlan =
  | { kind: 'open'; items: PresentedContent[]; placement: Placement }
  | { kind: 'change'; items: Presented['items'] }
  | { kind: 'arrange'; items: number[]; placement: Placement }
  | { kind: 'close'; items: number[] };

// What the window does next with a message from main: sends an answer at once, carries out a plan,
// then commits the command, or nothing yet, the command waiting for the drop.
export type Step =
  | { kind: 'answer'; answer: PresentationAnswer }
  | { kind: 'apply'; command: PresentationCommand; plan: PresentationPlan }
  | { kind: 'wait' };

// A presentation the page has, from the first command that shows it on this page until the page
// forgets it as one of the oldest with no panel open: whose it is, its title and version, and what
// each of its panels shows and whether it is open. Its agent's close, or another presentation taking
// its place, closes its panels as the user's close does, so the page goes on taking its commands.
export interface Presented {
  owner: string;
  title: string;
  version: number;
  items: { content: PresentedContent; open: boolean }[];
}

type Item = Presented['items'][number];

// How many answers the page keeps for repeated command IDs, and how many presentations with no open
// panel it keeps, the oldest going first, never one a command waiting for the drop is for. Main sends
// one command for a presentation at a time and waits seconds for each answer, so neither runs out
// while it matters.
const KEPT_ANSWERS = 256;
const KEPT_PRESENTATIONS = 512;

export class PresentationLedger {
  // In the order they were presented, the latest last.
  private readonly kept = new Map<string, Presented>();
  private readonly answers = new Map<string, { command: string; answer: PresentationAnswer }>();
  private held: { command: PresentationCommand; text: string; at: number }[] = [];

  // boxesOf: where the layout has each presentation's panels.
  constructor(
    readonly epoch: string,
    private readonly boxesOf: BoxesOf,
  ) {}

  // The presentations the page has, open or not.
  states(): PresentationState[] {
    return [...this.kept].map(([id, kept]) => this.stateOf(id, kept));
  }

  state(presentationId: string): PresentationState | null {
    const kept = this.kept.get(presentationId);
    return kept === undefined ? null : this.stateOf(presentationId, kept);
  }

  // A presentation, for its panels' headers and announcement.
  describe(presentationId: string): Presented | null {
    const kept = this.kept.get(presentationId);
    return kept === undefined ? null : structuredClone(kept);
  }

  // The session's presentation presented last of those with a panel open, whose place an opening
  // presentation takes where the area has no room for both.
  latestPresented(owner: string): string | null {
    let latest: string | null = null;
    for (const [id, kept] of this.kept) {
      if (kept.owner === owner && openItems(kept).length > 0) latest = id;
    }
    return latest;
  }

  // What to do with a message from main. A command ID already answered gets that answer again, or a
  // refusal as a conflict where it comes with other content; a cancel gets the command's answer, or
  // else cancels the command, which it stays. During a drag a command that would place panels waits
  // for the drop, a repeat of it waiting with it, and the same ID with other content is refused at
  // once; an update, which places none, goes ahead. The rules check any other command, refusing it at
  // once or giving the plan for the layout.
  receive(message: PresentationHostMessage, area: AreaFacts, now: number): Step {
    if (message.kind === 'cancel') return { kind: 'answer', answer: this.cancel(message) };
    const text = json(message);
    const answered = this.answers.get(message.commandId);
    if (answered !== undefined) {
      const same = answered.answer.kind === 'cancelled' || answered.command === text;
      return {
        kind: 'answer',
        answer: same ? answered.answer : this.refusal(message, 'command-conflict'),
      };
    }
    const held = this.held.find(({ command }) => command.commandId === message.commandId);
    if (held !== undefined) {
      return held.text === text
        ? { kind: 'wait' }
        : {
            kind: 'answer',
            answer: this.refusal(message, 'command-conflict'),
          };
    }
    if (area.dragging && message.kind !== 'update') {
      this.held.push({ command: message, text, at: now });
      return { kind: 'wait' };
    }
    return this.check(message, area);
  }

  // The drop: the commands that waited for it, in the order they came, which the window receives
  // again, one by one, once the drag is over.
  release(): PresentationCommand[] {
    const held = this.held.map(({ command }) => command);
    this.held = [];
    return held;
  }

  // Time passes: the commands that have waited as long as the window holds one are refused as busy.
  // Only a command still waiting is, so no answer already given changes.
  expire(now: number): PresentationAnswer[] {
    const expired = this.held.filter(({ at }) => now - at >= PRESENTATION_HOLD_MS);
    this.held = this.held.filter(({ at }) => now - at < PRESENTATION_HOLD_MS);
    return expired.map(({ command }) => this.refuse(command, 'busy'));
  }

  // Records a command the layout carried out, and returns the answer, with the presentation's new
  // state. A presentation of the session whose place it took is the layout's to report as displaced.
  commit(command: PresentationCommand, plan: PresentationPlan): PresentationAnswer {
    const id = command.presentationId;
    const before = this.kept.get(id);
    const after: Presented = {
      owner: command.owner,
      title: 'title' in command ? command.title : (before?.title ?? ''),
      // The rules applied the command at the presentation's version, or to one the page did not have,
      // which counts on from the version main gave.
      version: command.version + 1,
      items: itemsAfter(plan, before?.items ?? []),
    };
    // A present makes it its session's latest presentation; other commands leave its turn.
    if (command.kind === 'present') this.kept.delete(id);
    this.kept.set(id, after);
    this.forgetOldPresentations();
    const answer: PresentationAnswer = {
      kind: 'applied',
      commandId: command.commandId,
      epoch: this.epoch,
      state: this.stateOf(id, after),
    };
    this.remember(command, answer);
    return answer;
  }

  // The user closed panels of a presentation, by their places: the report main must hear, or none
  // where none of them was open.
  closed(presentationId: string, items: readonly number[]): PresentationReport | null {
    const kept = this.kept.get(presentationId);
    if (kept === undefined || !items.some((place) => kept.items[place]?.open === true)) return null;
    return this.change(presentationId, {
      ...kept,
      items: kept.items.map((item, place) =>
        items.includes(place) ? { ...item, open: false } : item,
      ),
    });
  }

  // The layout gave a presentation's open panels other boxes, as when the user moves or resizes one
  // of them or the layout around them changes.
  placed(presentationId: string): PresentationReport | null {
    const kept = this.kept.get(presentationId);
    if (kept === undefined || openItems(kept).length === 0) return null;
    return this.change(presentationId, kept);
  }

  // Another presentation of the session took this one's place, closing its panels.
  displaced(presentationId: string): PresentationReport | null {
    const kept = this.kept.get(presentationId);
    if (kept === undefined || openItems(kept).length === 0) return null;
    return this.change(presentationId, {
      ...kept,
      items: kept.items.map((item) => ({ ...item, open: false })),
    });
  }

  snapshot(sessionPanels: readonly SessionPanel[]): PresentationSnapshot {
    return {
      kind: 'snapshot',
      epoch: this.epoch,
      sessionPanels: structuredClone([...sessionPanels]),
      presentations: this.states(),
    };
  }

  private check(command: PresentationCommand, area: AreaFacts): Step {
    const refuse = (code: PresentationRefusal): Step => ({
      kind: 'answer',
      answer: this.refuse(command, code),
    });
    const apply = (plan: PresentationPlan): Step => ({ kind: 'apply', command, plan });
    if (command.epoch !== this.epoch) return refuse('stale-epoch');
    if (!commandWithinLimits(command)) return refuse('invalid-command');
    const id = command.presentationId;
    const kept = this.kept.get(id);
    if (kept === undefined) {
      return command.kind === 'present'
        ? apply({ kind: 'open', items: command.items, placement: command.placement })
        : refuse('presentation-unknown');
    }
    if (kept.owner !== command.owner) return refuse('wrong-owner');
    if (command.version !== kept.version) return refuse('presentation-changed');
    const open = openItems(kept);
    const unsaved = (place: number) => area.unsaved(id, place);
    switch (command.kind) {
      case 'present':
        if (open.length === 0) {
          return apply({ kind: 'open', items: command.items, placement: command.placement });
        }
        if (losesUnsaved(kept, command.items, unsaved)) return refuse('unsaved-changes');
        return apply({
          kind: 'change',
          items: command.items.map((content) => ({ content, open: true })),
        });
      case 'update':
        if (command.items.length !== kept.items.length) return refuse('item-count-mismatch');
        if (losesUnsaved(kept, command.items, unsaved)) return refuse('unsaved-changes');
        return apply({
          kind: 'change',
          items: command.items.map((content, place) => ({
            content,
            open: kept.items[place]?.open === true,
          })),
        });
      case 'arrange':
        return apply({ kind: 'arrange', items: open, placement: command.placement });
      case 'close':
        if (losesUnsaved(kept, [], unsaved)) return refuse('unsaved-changes');
        return apply({ kind: 'close', items: open });
    }
  }

  // Records a change that no command for the presentation made, at its next version, and gives the
  // report main must hear: the presentation's latest state.
  private change(id: string, changed: Presented): PresentationReport {
    const after = { ...changed, version: changed.version + 1 };
    this.kept.set(id, after);
    this.forgetOldPresentations();
    return { kind: 'changed', epoch: this.epoch, state: this.stateOf(id, after) };
  }

  private stateOf(id: string, kept: Presented): PresentationState {
    const open = kept.items.map((item) => item.open);
    const boxes = this.boxesOf(id, open);
    return {
      presentationId: id,
      owner: kept.owner,
      version: kept.version,
      boxes: open.map((isOpen, place) => {
        const box = boxes[place];
        return isOpen && box !== undefined && box !== null ? { ...box } : null;
      }),
    };
  }

  // Answers main's withdrawal of a command: with the answer the command already had, or else as
  // cancelled, which it stays, the command no longer waiting if it was.
  private cancel(message: PresentationCancel): PresentationAnswer {
    const answered = this.answers.get(message.commandId);
    if (answered !== undefined) return answered.answer;
    this.held = this.held.filter(({ command }) => command.commandId !== message.commandId);
    const answer: PresentationAnswer = {
      kind: 'cancelled',
      commandId: message.commandId,
      epoch: this.epoch,
    };
    this.answers.set(message.commandId, { command: '', answer });
    this.forgetOldAnswers();
    return answer;
  }

  private refuse(command: PresentationCommand, code: PresentationRefusal): PresentationAnswer {
    const answer = this.refusal(command, code);
    this.remember(command, answer);
    return answer;
  }

  private refusal(command: PresentationCommand, code: PresentationRefusal): PresentationAnswer {
    return {
      kind: 'refused',
      commandId: command.commandId,
      epoch: this.epoch,
      presentationId: command.presentationId,
      code,
      // Another session's presentation is not described to this one.
      state: code === 'wrong-owner' ? null : this.state(command.presentationId),
    };
  }

  // The first answer to a command ID is the one it keeps.
  private remember(command: PresentationCommand, answer: PresentationAnswer): void {
    if (this.answers.has(command.commandId)) return;
    this.answers.set(command.commandId, { command: json(command), answer });
    this.forgetOldAnswers();
  }

  private forgetOldAnswers(): void {
    for (const id of this.answers.keys()) {
      if (this.answers.size <= KEPT_ANSWERS) return;
      this.answers.delete(id);
    }
  }

  private forgetOldPresentations(): void {
    const waiting = new Set(this.held.map(({ command }) => command.presentationId));
    for (const [id, kept] of this.kept) {
      if (this.kept.size <= KEPT_PRESENTATIONS) return;
      if (openItems(kept).length === 0 && !waiting.has(id)) this.kept.delete(id);
    }
  }
}

// A presentation's panels after a plan.
function itemsAfter(plan: PresentationPlan, before: readonly Item[]): Item[] {
  switch (plan.kind) {
    case 'open':
      return plan.items.map((content) => ({ content, open: true }));
    case 'change':
      return plan.items.map((item) => ({ ...item }));
    case 'arrange':
      return [...before];
    case 'close':
      return before.map((item) => ({ ...item, open: false }));
  }
}

// Whether showing these items in a presentation's panels, in order, would close an open panel that
// holds unsaved changes, or show something else in it.
function losesUnsaved(
  kept: Presented,
  items: readonly PresentedContent[],
  unsaved: (place: number) => boolean,
): boolean {
  return kept.items.some((item, place) => {
    const next = items[place];
    return item.open && unsaved(place) && (next === undefined || !sameContent(next, item.content));
  });
}

function openItems(kept: Presented): number[] {
  return kept.items.flatMap((item, place) => (item.open ? [place] : []));
}

function json(command: PresentationCommand): string {
  return JSON.stringify(command);
}
