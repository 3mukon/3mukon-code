import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLACEMENT,
  type PanelBox,
  type PresentationCommand,
  type PresentedContent,
} from './presentation';
import {
  PresentationLedger,
  type AreaFacts,
  type PresentationPlan,
  type Step,
} from './presentation-ledger';

const notes: PresentedContent = { kind: 'artifact', artifactId: 'artifact-1' };
const page: PresentedContent = { kind: 'browser', tabId: 'tab-1' };
const file: PresentedContent = { kind: 'file', path: '/work/notes.md' };
const box: PanelBox = { x: 0.5, y: 0, width: 0.5, height: 1 };

const area: AreaFacts = { dragging: false, unsaved: () => false };

// A ledger whose layout gives every panel the same box, and a way to send it commands at the
// presentation's latest version, carrying out the plan the rules give as the layout would.
function setUp() {
  const ledger = new PresentationLedger('page-1', (_, open) => open.map(() => box));
  let commands = 0;
  const send = (kind: 'present' | 'update', items: PresentedContent[]): PresentationPlan => {
    const basis = {
      commandId: `command-${String(++commands)}`,
      epoch: ledger.epoch,
      owner: 'session-1',
      presentationId: 'presentation-1',
      version: ledger.state('presentation-1')?.version ?? 0,
      title: 'Pricing compared',
      items,
    };
    const command: PresentationCommand =
      kind === 'present' ? { ...basis, kind, placement: DEFAULT_PLACEMENT } : { ...basis, kind };
    const step: Step = ledger.receive(command, area, 0);
    if (step.kind !== 'apply') throw new Error(`not applied: ${JSON.stringify(step)}`);
    ledger.commit(step.command, step.plan);
    return step.plan;
  };
  return { ledger, send };
}

describe("the plans the window's rules give its layout", () => {
  it("gives each of a presentation's panels, in order, what it shows and whether it is open", () => {
    const { ledger, send } = setUp();
    expect(send('present', [notes, page])).toEqual({
      kind: 'open',
      items: [notes, page],
      placement: DEFAULT_PLACEMENT,
    });
    ledger.closed('presentation-1', [1]);
    expect(send('update', [file, notes])).toEqual({
      kind: 'change',
      items: [
        { content: file, open: true },
        { content: notes, open: false },
      ],
    });
    expect(ledger.describe('presentation-1')?.items).toEqual([
      { content: file, open: true },
      { content: notes, open: false },
    ]);
    expect(ledger.state('presentation-1')?.boxes).toEqual([box, null]);
  });

  it('opens every panel with a present, as many as it gives, in place of an open presentation', () => {
    const { ledger, send } = setUp();
    send('present', [notes, page]);
    ledger.closed('presentation-1', [1]);
    expect(send('present', [page])).toEqual({
      kind: 'change',
      items: [{ content: page, open: true }],
    });
  });
});
