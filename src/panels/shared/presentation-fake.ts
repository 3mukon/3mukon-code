import {
  isOpen,
  type PanelBox,
  type PresentationCommand,
  type PresentationHostMessage,
  type PresentationRendererMessage,
  type PresentationReport,
  type ShowOutcome,
  type UsedContent,
} from './presentation';
import {
  PresentationLedger,
  type AreaFacts,
  type PresentationPlan,
  type Step,
} from './presentation-ledger';

// Where the fake lays out every session's own panel: the left half of the area.
export const FAKE_SESSION_BOX: PanelBox = { x: 0, y: 0, width: 0.5, height: 1 };

// A stand-in for the window's side of the presentation contract, for main's tests. It answers main's
// messages by the window's own rules (PresentationLedger), over an area it only pretends to lay out:
// sessions' panels take its left half, and each presentation's open panels lie side by side across
// its right half, unless the test has placed them. A test can act as the user, who opens and closes
// sessions' panels, leaves no room beside one, edits files, drags, moves, resizes and closes panels and
// asks to see presentations again, whose outcomes it keeps by request; change the layout around a
// presentation; or reload, which starts a new page that has nothing. Time stands still until the test
// advances it.
export class FakePresentationWindow {
  private ledger: PresentationLedger;
  private pages = 1;
  private shows = 0;
  // The outcomes main gave the user's requests to see something again, by request.
  readonly showOutcomes = new Map<string, ShowOutcome>();
  private now = 0;
  private dragging = false;
  private readonly sessions: Set<string>;
  private readonly cramped = new Set<string>();
  private readonly unsavedItems = new Set<string>();
  // The boxes the test placed a presentation's panels in, which hold until a command other than an
  // update, or the user's close, places them anew.
  private readonly placedBoxes = new Map<string, (PanelBox | null)[]>();

  // send receives what the window sends main, starting with the first page's snapshot.
  constructor(
    private readonly send: (message: PresentationRendererMessage) => void,
    sessionsShown: Iterable<string> = [],
  ) {
    this.sessions = new Set(sessionsShown);
    this.ledger = this.newPage();
    this.sendSnapshot();
  }

  get epoch(): string {
    return this.ledger.epoch;
  }

  // A message from main, as the preload bridge delivers it.
  receive(message: PresentationHostMessage): void {
    if (message.kind === 'show-answer') {
      if (message.epoch === this.epoch) this.showOutcomes.set(message.requestId, message.outcome);
      return;
    }
    this.take(this.ledger.receive(message, this.facts(), this.now));
  }

  // The user opens or closes a session's own panel, which leaves its presentations as they are and
  // sends main a snapshot.
  showSession(owner: string): void {
    this.sessions.add(owner);
    this.sendSnapshot();
  }

  hideSession(owner: string): void {
    this.sessions.delete(owner);
    this.sendSnapshot();
  }

  // Whether the area has room for another presentation of the session, as it has at first.
  setRoom(owner: string, room: boolean): void {
    if (room) this.cramped.delete(owner);
    else this.cramped.add(owner);
  }

  // Whether the file panel of one of a presentation's items holds unsaved changes.
  setUnsaved(presentationId: string, item: number, unsaved: boolean): void {
    if (unsaved) this.unsavedItems.add(itemKey(presentationId, item));
    else this.unsavedItems.delete(itemKey(presentationId, item));
  }

  // The user closes panels of a presentation, by their places, or all of them.
  close(presentationId: string, items?: readonly number[]): void {
    const state = this.ledger.state(presentationId);
    if (state === null) return;
    const places = items ?? state.boxes.map((_, place) => place);
    if (!places.some((place) => (state.boxes[place] ?? null) !== null)) return;
    this.placedBoxes.delete(presentationId);
    for (const place of places) this.unsavedItems.delete(itemKey(presentationId, place));
    this.report(this.ledger.closed(presentationId, places));
  }

  // A presentation's open panels come to lie in the boxes given, or stay where they were: the user
  // moves or resizes one of them, or the layout around them changes, as when the user opens a panel
  // beside them.
  move(presentationId: string, boxes?: (PanelBox | null)[]): void {
    const state = this.ledger.state(presentationId);
    if (state === null || !isOpen(state)) return;
    if (boxes !== undefined) this.placedBoxes.set(presentationId, structuredClone(boxes));
    this.report(this.ledger.placed(presentationId));
  }

  // The user asks, from a session's activity, to see one of its presentations again: the request's
  // id, by which showOutcomes keeps main's answer.
  requestShow(owner: string, presentationId: string): string {
    const requestId = this.nextShow();
    this.send({ kind: 'show', epoch: this.epoch, requestId, owner, presentationId });
    return requestId;
  }

  // The user asks, from the line above a session's composer, to see a tab or application the session
  // uses that no presentation shows.
  requestShowContent(owner: string, content: UsedContent): string {
    const requestId = this.nextShow();
    this.send({
      kind: 'show',
      epoch: this.epoch,
      requestId,
      owner,
      content: structuredClone(content),
    });
    return requestId;
  }

  startDrag(): void {
    this.dragging = true;
  }

  // The drop: the commands that waited for it apply, in the order they came.
  endDrag(): void {
    this.dragging = false;
    for (const command of this.ledger.release()) this.receive(command);
  }

  // Time passes: a command that waited as long as the window holds one is refused as busy.
  advance(milliseconds: number): void {
    this.now += milliseconds;
    for (const answer of this.ledger.expire(this.now)) this.send(answer);
  }

  // A reload, or the window closed and opened again: a new page, which has nothing, not even a
  // session's panel, and has forgotten what the old one held and was told.
  reload(): void {
    this.pages += 1;
    this.ledger = this.newPage();
    this.dragging = false;
    this.sessions.clear();
    this.cramped.clear();
    this.unsavedItems.clear();
    this.placedBoxes.clear();
    this.sendSnapshot();
  }

  private nextShow(): string {
    this.shows += 1;
    return `fake-show-${String(this.shows)}`;
  }

  private newPage(): PresentationLedger {
    return new PresentationLedger(`fake-page-${String(this.pages)}`, (id, open) =>
      this.boxesOf(id, open),
    );
  }

  private take(step: Step): void {
    if (step.kind === 'wait') return;
    if (step.kind === 'answer') {
      this.send(step.answer);
      return;
    }
    const { command, plan } = step;
    const replaced = this.replacedBy(command.owner, plan);
    const displaced = replaced === null ? null : this.displace(replaced);
    this.follow(command, plan);
    this.send(this.ledger.commit(command, plan));
    if (displaced !== null) this.send(displaced);
  }

  // The session's presentation an opening one takes the place of, where the area has no room for
  // both, unless one of its panels holds unsaved changes, when it opens beside it anyway.
  private replacedBy(owner: string, plan: PresentationPlan): string | null {
    if (plan.kind !== 'open' || !this.cramped.has(owner)) return null;
    const latest = this.ledger.latestPresented(owner);
    if (latest === null) return null;
    const boxes = this.ledger.state(latest)?.boxes ?? [];
    return boxes.some((box, item) => box !== null && this.unsavedItems.has(itemKey(latest, item)))
      ? null
      : latest;
  }

  private displace(presentationId: string): PresentationReport | null {
    this.forgetUnsaved(presentationId);
    this.placedBoxes.delete(presentationId);
    return this.ledger.displaced(presentationId);
  }

  // Unsaved changes stay with the file panel that holds them, which no command closes or shows
  // anything else in; a presentation that opens anew or closes has none. A command other than an
  // update places the presentation's panels anew.
  private follow(command: PresentationCommand, plan: PresentationPlan): void {
    if (plan.kind === 'open' || plan.kind === 'close') this.forgetUnsaved(command.presentationId);
    if (command.kind !== 'update') this.placedBoxes.delete(command.presentationId);
  }

  private report(report: PresentationReport | null): void {
    if (report !== null) this.send(report);
  }

  // Where a presentation's panels lie: in the boxes the test placed them in, or else its open panels
  // side by side across the right half of the area.
  private boxesOf(presentationId: string, open: readonly boolean[]): (PanelBox | null)[] {
    const placed = this.placedBoxes.get(presentationId);
    if (placed !== undefined) return placed;
    const width = 0.5 / Math.max(1, open.filter((isOpen) => isOpen).length);
    let x = 0.5;
    return open.map((isOpen) => {
      if (!isOpen) return null;
      const box = { x, y: 0, width, height: 1 };
      x += width;
      return box;
    });
  }

  private forgetUnsaved(presentationId: string): void {
    for (const key of this.unsavedItems) {
      if (key.startsWith(itemKey(presentationId, ''))) this.unsavedItems.delete(key);
    }
  }

  private facts(): AreaFacts {
    return {
      dragging: this.dragging,
      unsaved: (presentationId, item) => this.unsavedItems.has(itemKey(presentationId, item)),
    };
  }

  private sendSnapshot(): void {
    const sessionPanels = [...this.sessions].map((owner) => ({ owner, box: FAKE_SESSION_BOX }));
    this.send(this.ledger.snapshot(sessionPanels));
  }
}

function itemKey(presentationId: string, item: number | ''): string {
  return `${presentationId}\n${String(item)}`;
}
