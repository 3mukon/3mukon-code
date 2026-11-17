import {
  PRESENTATION_HOLD_MS,
  type PanelBox,
  type Placement,
  type PresentationBridge,
  type PresentationCommand,
  type PresentationHostMessage,
  type PresentationRendererMessage,
  type SessionPanel,
  type ShowOutcome,
  type UsedContent,
} from '../shared/presentation';
import {
  PresentationLedger,
  type AreaFacts,
  type PresentationPlan,
  type Step,
} from '../shared/presentation-ledger';
import { arrange, type Box } from './geometry';
import { panelsOf, presentedPanels, type Layout, type Panel, type PresentChange } from './layout';
import type { Panels } from './use-panels';

// The smallest a presented panel may be beside its session's panel, in pixels. Where the panels of a
// presentation that opens would be smaller, it takes the place of its session's presentation presented
// last, if it has one with a panel open.
export const PRESENTED_MIN = { width: 280, height: 180 } as const;

// How long the layout stays still before the page reports where presentations' and sessions' panels
// have come to lie, so that a divider dragged across the area is reported once, where it stops.
export const SETTLE_MS = 250;

// What the page needs of the panel area.
export interface PresentationArea {
  // Whether a panel holds unsaved changes.
  unsaved(panel: Panel): boolean;
  // The area's size, in pixels.
  size(): { width: number; height: number };
  // A presentation opened panels, which VoiceOver announces.
  opened(owner: string, title: string): void;
}

// One page's side of the presentation contract (shared/presentation.ts): its ledger, whose plans it
// carries out on the panel area's layout without moving the focus, and the answers, reports and
// snapshots it sends main. Each command applies at once, its answer giving where its panels came to
// lie; a close by the user, or a drop that takes a presented panel's place, is reported at once; and
// a change in where presentations' or sessions' panels lie, once the layout has stayed still for
// SETTLE_MS. Commands that would place panels during a drag wait for the drop, for up to
// PRESENTATION_HOLD_MS. The user's requests to see something again go to main under ids of the page's
// own, each settled by main's answer, or as unavailable once the page stops.
export class PresentationPage {
  private readonly ledger: PresentationLedger;
  private dragging = false;
  private applying = false;
  // Where main last heard each presentation's panels lie, and the sessions' panels.
  private readonly sentBoxes = new Map<string, string>();
  private sentSessions = '';
  private settling: ReturnType<typeof setTimeout> | undefined;
  private readonly holding = new Set<ReturnType<typeof setTimeout>>();
  private readonly shows = new Map<string, (outcome: ShowOutcome) => void>();

  constructor(
    private readonly bridge: PresentationBridge,
    private readonly panels: Pick<Panels, 'latest' | 'present' | 'subscribe'>,
    private readonly area: PresentationArea,
    epoch: string = crypto.randomUUID(),
  ) {
    this.ledger = new PresentationLedger(epoch, (presentationId, open) =>
      boxesOf(this.panels.latest().layout, presentationId, open),
    );
  }

  // Listens to main and to the layout, then sends the page's first snapshot; the function returned
  // stops it all.
  start(): () => void {
    const stopMessages = this.bridge.onMessage((message) => {
      this.receive(message);
    });
    const stopLayout = this.panels.subscribe(() => {
      this.layoutChanged();
    });
    this.sendSnapshot();
    return () => {
      stopMessages();
      stopLayout();
      clearTimeout(this.settling);
      for (const timer of this.holding) clearTimeout(timer);
      this.holding.clear();
      for (const settle of this.shows.values()) settle('unavailable');
      this.shows.clear();
    };
  }

  // The user asks to see one of a session's presentations again, or a tab or application it uses
  // that no presentation shows: what became of it, as main answers.
  show(
    owner: string,
    what: { presentationId: string } | { content: UsedContent },
  ): Promise<ShowOutcome> {
    const requestId = crypto.randomUUID();
    const answered = new Promise<ShowOutcome>((resolve) => {
      this.shows.set(requestId, resolve);
    });
    this.send({ kind: 'show', epoch: this.ledger.epoch, requestId, owner, ...what });
    return answered;
  }

  // The user starts or ends a drag in the area. At the drop, the commands that waited for it apply,
  // in the order they came.
  setDragging(dragging: boolean): void {
    if (dragging === this.dragging) return;
    this.dragging = dragging;
    if (!dragging) for (const command of this.ledger.release()) this.receive(command);
  }

  private receive(message: PresentationHostMessage): void {
    if (message.kind === 'show-answer') {
      const settle = message.epoch === this.ledger.epoch ? this.shows.get(message.requestId) : null;
      this.shows.delete(message.requestId);
      settle?.(message.outcome);
      return;
    }
    this.take(this.ledger.receive(message, this.facts(), Date.now()));
  }

  private take(step: Step): void {
    if (step.kind === 'wait') {
      this.expireLater();
      return;
    }
    if (step.kind === 'answer') {
      this.send(step.answer);
      return;
    }
    const { command, plan } = step;
    const replacing = plan.kind === 'open' ? this.replaced(command.owner, plan) : null;
    this.applying = true;
    try {
      this.panels.present(command.presentationId, changeFor(command, plan, replacing));
    } finally {
      this.applying = false;
    }
    this.send(this.ledger.commit(command, plan));
    const displaced = replacing === null ? null : this.ledger.displaced(replacing);
    if (displaced !== null) this.send(displaced);
    if (plan.kind === 'open' && command.kind === 'present') {
      this.area.opened(command.owner, command.title);
    }
  }

  // The session's presentation presented last, whose place an opening one takes where its panels
  // would be smaller than PRESENTED_MIN beside the session's panel, unless one of its panels holds
  // unsaved changes, when the new one opens beside the session's panel anyway.
  private replaced(
    owner: string,
    plan: Extract<PresentationPlan, { kind: 'open' }>,
  ): string | null {
    const latest = this.ledger.latestPresented(owner);
    const { layout } = this.panels.latest();
    if (latest === null || hasRoom(layout, owner, plan, this.area.size())) return null;
    const unsaved = presentedPanels(layout, latest).some((panel) => this.area.unsaved(panel));
    return unsaved ? null : latest;
  }

  // Something other than a command changed the layout: the user closed, moved or resized panels,
  // opened others, or dropped an item in a presented panel's place.
  private layoutChanged(): void {
    if (!this.applying) this.reportCloses();
    clearTimeout(this.settling);
    this.settling = setTimeout(() => {
      this.settle();
    }, SETTLE_MS);
  }

  // Each presentation whose panels have gone from the layout, which main must hear of at once.
  private reportCloses(): void {
    const { layout } = this.panels.latest();
    for (const { presentationId } of this.ledger.states()) {
      const presented = this.ledger.describe(presentationId);
      if (presented === null) continue;
      const shown = new Set(presentedPanels(layout, presentationId).map((p) => p.presented?.item));
      const gone = presented.items.flatMap((item, place) =>
        item.open && !shown.has(place) ? [place] : [],
      );
      const report = gone.length === 0 ? null : this.ledger.closed(presentationId, gone);
      if (report !== null) this.send(report);
    }
  }

  // The layout has stayed still: the presentations whose panels lie elsewhere than main last heard,
  // and the sessions' panels, if they changed.
  private settle(): void {
    for (const state of this.ledger.states()) {
      if (!state.boxes.some((box) => box !== null)) continue;
      if (JSON.stringify(state.boxes) === this.sentBoxes.get(state.presentationId)) continue;
      const report = this.ledger.placed(state.presentationId);
      if (report !== null) this.send(report);
    }
    if (JSON.stringify(sessionPanelsOf(this.panels.latest().layout)) !== this.sentSessions) {
      this.sendSnapshot();
    }
  }

  private expireLater(): void {
    const timer = setTimeout(() => {
      this.holding.delete(timer);
      for (const answer of this.ledger.expire(Date.now())) this.send(answer);
    }, PRESENTATION_HOLD_MS);
    this.holding.add(timer);
  }

  private facts(): AreaFacts {
    return {
      dragging: this.dragging,
      unsaved: (presentationId, item) =>
        presentedPanels(this.panels.latest().layout, presentationId).some(
          (panel) => panel.presented?.item === item && this.area.unsaved(panel),
        ),
    };
  }

  private sendSnapshot(): void {
    this.send(this.ledger.snapshot(sessionPanelsOf(this.panels.latest().layout)));
  }

  private send(message: PresentationRendererMessage): void {
    if (message.kind === 'applied' || message.kind === 'changed') {
      this.sentBoxes.set(message.state.presentationId, JSON.stringify(message.state.boxes));
    }
    if (message.kind === 'snapshot') this.sentSessions = JSON.stringify(message.sessionPanels);
    this.bridge.send(message);
  }
}

// What the ledger's plan asks of the layout.
function changeFor(
  command: PresentationCommand,
  plan: PresentationPlan,
  replacing: string | null,
): PresentChange {
  switch (plan.kind) {
    case 'open':
      return {
        kind: 'open',
        owner: command.owner,
        title: titleOf(command),
        items: plan.items,
        placement: plan.placement,
        replacing,
      };
    case 'change':
      return {
        kind: 'change',
        owner: command.owner,
        title: titleOf(command),
        items: plan.items,
        direction: command.kind === 'present' ? command.placement.direction : 'row',
      };
    case 'arrange':
      return { kind: 'arrange', owner: command.owner, placement: plan.placement };
    case 'close':
      return { kind: 'close' };
  }
}

// The title a command gives its presentation; only a present or an update carries one, and only they
// open or change panels.
function titleOf(command: PresentationCommand): string {
  return command.kind === 'present' || command.kind === 'update' ? command.title : '';
}

// Where a presentation's panels lie, by their places: a box for each item given as open that has a
// panel.
export function boxesOf(
  layout: Layout | null,
  presentationId: string,
  open: readonly boolean[],
): (PanelBox | null)[] {
  const boxes = arrange(layout).panels;
  const shown = new Map(
    presentedPanels(layout, presentationId).map((panel) => [panel.presented?.item, panel.id]),
  );
  return open.map((isOpen, item) => {
    const id = shown.get(item);
    const box = id === undefined ? undefined : boxes.get(id);
    return isOpen && box !== undefined ? { ...box } : null;
  });
}

// The sessions' own panels and where they lie.
export function sessionPanelsOf(layout: Layout | null): SessionPanel[] {
  const boxes = arrange(layout).panels;
  return panelsOf(layout).flatMap((panel) => {
    const box = boxes.get(panel.id);
    return panel.content.kind === 'session' && box !== undefined
      ? [{ owner: panel.content.id, box: { ...box } }]
      : [];
  });
}

// Whether the panels of a presentation that opens would be at least PRESENTED_MIN beside its
// session's first panel, or at that side of the area while the session has none, each taking an
// equal share of half the space there.
export function hasRoom(
  layout: Layout | null,
  owner: string,
  opening: { items: readonly unknown[]; placement: Placement },
  size: { width: number; height: number },
): boolean {
  const whole: Box = { x: 0, y: 0, width: 1, height: 1 };
  const session = panelsOf(layout).find(
    (panel) => panel.content.kind === 'session' && panel.content.id === owner,
  );
  const box = (session === undefined ? undefined : arrange(layout).panels.get(session.id)) ?? whole;
  const across = opening.placement.side === 'left' || opening.placement.side === 'right';
  const count = Math.max(1, opening.items.length);
  const width = (box.width * size.width) / (across ? 2 : 1);
  const height = (box.height * size.height) / (across ? 1 : 2);
  const row = opening.placement.direction === 'row';
  return (
    (row ? width / count : width) >= PRESENTED_MIN.width &&
    (row ? height : height / count) >= PRESENTED_MIN.height
  );
}
