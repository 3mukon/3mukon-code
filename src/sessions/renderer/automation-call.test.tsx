import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { FrameSummary, TargetSummary } from '../shared/automation';
import type { MessageImage } from '../shared/events';
import { AutomationCall } from './automation-call';
import type { UseCall } from './automation-labels';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

const tab: TargetSummary = {
  ref: { id: 'tab-1', kind: 'browser-tab', generation: 1 },
  owner: 's1',
  name: 'Pricing · Example',
  address: 'https://example.com/pricing',
  sharing: 'none',
  browser: 'embedded',
};

const frame: FrameSummary = {
  target: tab.ref,
  observationId: 'o1',
  documentGeneration: 1,
  geometryGeneration: 1,
  capturedAt: 1,
  mediaType: 'image/png',
  imageSize: { width: 2, height: 2 },
  viewport: { x: 0, y: 0, width: 2, height: 2 },
  units: 'css-pixels',
  imageToViewport: [1, 0, 0, 1, 0, 0],
};

const shot: MessageImage = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };

function call(fields: Partial<UseCall>): UseCall {
  return {
    callId: 'c1',
    sessionId: 's1',
    turnId: 'turn-1',
    accessGeneration: 1,
    revision: 1,
    toolName: 'browser_navigate',
    operationId: null,
    operationEnd: null,
    grantId: null,
    grantEnd: null,
    approval: null,
    incidents: [],
    startedAt: 1,
    completedAt: 2,
    phase: 'settled',
    outcome: { status: 'verified', value: null },
    frames: [],
    framesState: 'available',
    providerEntry: null,
    family: 'browser',
    target: { state: 'resolved', summary: tab },
    sharing: 'none',
    delivery: 'background',
    ...fields,
  };
}

const noFrames = () => Promise.resolve([]);
const settle = () => act(() => Promise.resolve());

// A line's title, whose words and object are drawn apart, by the words it reads.
function title(words: string): HTMLElement {
  return screen.getByText(
    (_, element) =>
      element instanceof HTMLElement &&
      element.classList.contains('truncate') &&
      element.textContent === words,
  );
}

// The sign at the start of the line a title stands in.
function signOf(line: HTMLElement): Element | null {
  return line.parentElement?.querySelector('svg') ?? null;
}

describe('AutomationCall', () => {
  it('names what a call did in the ink and the page apart, with its sharing and delivery in tags where it opens the page', () => {
    render(<AutomationCall record={call({})} loadFrames={noFrames} />);
    const opened = title('Opened example.com/pricing');
    expect(screen.getByText('Opened').className).toContain('text-ink');
    expect(screen.getByText('example.com/pricing').className).toContain('text-[12px]');
    expect(screen.getByText('example.com/pricing').className).not.toContain('text-ink');
    expect(screen.getByText('No sharing')).toBeDefined();
    expect(screen.getByText('Background')).toBeDefined();
    expect(signOf(opened)?.getAttribute('class')).toContain('text-faint');
    cleanup();
    render(
      <AutomationCall
        record={call({
          toolName: 'browser_navigate',
          sharing: 'global',
          target: {
            state: 'resolved',
            summary: {
              ...tab,
              sharing: 'global',
              browser: 'chrome',
              profile: { id: 'p', name: 'Personal' },
            },
          },
        })}
        loadFrames={noFrames}
      />,
    );
    expect(screen.getByText('Chrome · Personal')).toBeDefined();
    cleanup();
    render(
      <AutomationCall record={call({ toolName: 'browser_snapshot' })} loadFrames={noFrames} />,
    );
    title('Read the page');
    expect(screen.queryByText('No sharing')).toBeNull();
    expect(screen.queryByText('Background')).toBeNull();
  });

  it('names a blank tab, a tool it does not know, and an unresolved target', () => {
    render(
      <AutomationCall
        record={call({ toolName: 'browser_open', target: { state: 'unresolved' } })}
        loadFrames={noFrames}
      />,
    );
    title('Opened a tab');
    cleanup();
    render(
      <AutomationCall
        record={call({ toolName: 'browser_navigate', target: { state: 'unresolved' } })}
        loadFrames={noFrames}
      />,
    );
    title('Opened a page');
    cleanup();
    render(
      <AutomationCall
        record={call({ toolName: 'browser_act', target: { state: 'unresolved' } })}
        loadFrames={noFrames}
      />,
    );
    title('Acted on the page');
    cleanup();
    render(<AutomationCall record={call({ toolName: 'browser_zoom' })} loadFrames={noFrames} />);
    title('browser_zoom: example.com/pricing');
  });

  it('names clicks, typing and scrolling by the observed label, with a pointer for a click', () => {
    const cases: [Partial<UseCall>, string, string][] = [
      [
        {
          browserAction: { kind: 'click', label: 'Save Draft' },
          outcome: { status: 'dispatched', evidence: 'not-verified' },
        },
        'Clicked “Save Draft”',
        'lucide-mouse-pointer-2',
      ],
      [{ browserAction: { kind: 'type', label: 'Name' } }, 'Typed in “Name”', 'lucide-globe'],
      [{ browserAction: { kind: 'type' } }, 'Typed on the page', 'lucide-globe'],
      [{ browserAction: { kind: 'scroll' } }, 'Scrolled the page', 'lucide-globe'],
      [
        {
          browserAction: { kind: 'click' },
          outcome: { status: 'refused', code: 'stale-observation', dispatched: false },
        },
        'Clicked on the page',
        'lucide-circle-alert',
      ],
    ];
    for (const [fields, words, sign] of cases) {
      render(
        <AutomationCall
          record={call({ toolName: 'browser_act', ...fields })}
          loadFrames={noFrames}
        />,
      );
      expect(signOf(title(words))?.getAttribute('class')).toContain(sign);
      cleanup();
    }
  });

  it('names the computer tools’ calls by what they did, with the application in the words', () => {
    const mail: TargetSummary = {
      ref: { id: 'app-1', kind: 'application', generation: 1 },
      owner: 's1',
      name: 'Mail',
    };
    const cases: [string, string][] = [
      ['computer_targets', 'Listed the running apps'],
      ['computer_select', 'Chose Mail'],
      ['computer_windows', 'Looked for Mail’s windows'],
      ['computer_observe', 'Looked at Mail'],
      ['computer_act', 'Acted in Mail'],
      ['computer_release', 'Stopped using Mail'],
    ];
    for (const [toolName, words] of cases) {
      render(
        <AutomationCall
          record={call({
            toolName,
            family: 'computer',
            target: { state: 'resolved', summary: mail },
            sharing: null,
          })}
          loadFrames={noFrames}
        />,
      );
      expect(signOf(title(words))?.getAttribute('class')).toContain('lucide-monitor');
      cleanup();
    }
    render(
      <AutomationCall
        record={call({
          toolName: 'computer_select',
          family: 'computer',
          target: { state: 'unresolved' },
          sharing: null,
        })}
        loadFrames={noFrames}
      />,
    );
    title('Chose an app');
  });

  it('names a computer action by its control, with the application in a tag, and a window’s change', () => {
    const inbox: TargetSummary = {
      ref: { id: 'window-1', kind: 'window', generation: 1 },
      owner: 's1',
      name: 'Inbox',
      applicationName: 'Mail',
    };
    const cases: [Partial<UseCall>, string, string][] = [
      [
        {
          computerAction: { kind: 'click', label: 'Save Draft' },
          outcome: { status: 'dispatched', evidence: 'not-verified' },
        },
        'Clicked “Save Draft”',
        'lucide-mouse-pointer-2',
      ],
      [{ computerAction: { kind: 'type', label: 'To' } }, 'Typed in “To”', 'lucide-monitor'],
      [
        { computerAction: { kind: 'point-click' } },
        'Clicked in the window',
        'lucide-mouse-pointer-2',
      ],
      [{ computerAction: { kind: 'press' } }, 'Pressed keys', 'lucide-monitor'],
      [
        { computerAction: { kind: 'window', change: 'move' } },
        'Moved the window',
        'lucide-monitor',
      ],
      [{}, 'Acted in Inbox', 'lucide-monitor'],
    ];
    for (const [fields, words, sign] of cases) {
      render(
        <AutomationCall
          record={call({
            toolName: 'computer_act',
            family: 'computer',
            target: { state: 'resolved', summary: inbox },
            sharing: null,
            ...fields,
          })}
          loadFrames={noFrames}
        />,
      );
      const line = title(words);
      expect(signOf(line)?.getAttribute('class')).toContain(sign);
      expect(line.parentElement?.textContent).toContain('Mail');
      cleanup();
    }
  });

  it('names a refused or stopped action by what it tried, and a sandbox refusal by its level', () => {
    render(
      <AutomationCall
        record={call({
          toolName: 'browser_act',
          browserAction: { kind: 'click', label: 'Delete account' },
          outcome: {
            status: 'refused',
            code: 'sandbox-denied',
            dispatched: false,
            detail: { kind: 'sandbox', level: 'read-only' },
          },
        })}
        loadFrames={noFrames}
      />,
    );
    const refused = title('Clicked “Delete account”');
    expect(signOf(refused)?.getAttribute('class')).toContain('text-wait');
    expect(screen.getByText('Not allowed in Read-only')).toBeDefined();
    cleanup();
    render(
      <AutomationCall
        record={call({
          toolName: 'browser_act',
          browserAction: { kind: 'click', label: 'Archive' },
          outcome: {
            status: 'indeterminate',
            reason: 'cancelled-after-dispatch',
            exclusionHeld: false,
          },
        })}
        loadFrames={noFrames}
      />,
    );
    title('Clicked “Archive”');
    expect(screen.getByText('Stopped, may have happened')).toBeDefined();
  });

  it('says whether an effect was checked, why a call was refused and what may have happened, with a sign in the wait colour where it did not finish', () => {
    const cases: [Partial<UseCall>, string, boolean][] = [
      [
        { outcome: { status: 'dispatched', evidence: 'not-verified' } },
        'Effect not checked',
        false,
      ],
      [
        { outcome: { status: 'refused', code: 'sandbox-denied', dispatched: false } },
        'Not allowed at this sandbox level',
        true,
      ],
      [
        {
          outcome: {
            status: 'refused',
            code: 'denied',
            dispatched: false,
            detail: { kind: 'denial', message: 'Use the exported CSV instead' },
          },
        },
        'Denied · “Use the exported CSV instead”',
        true,
      ],
      [
        {
          outcome: {
            status: 'indeterminate',
            reason: 'cancelled-after-dispatch',
            exclusionHeld: false,
          },
        },
        'Stopped, may have happened',
        true,
      ],
      [
        { outcome: { status: 'partial', completed: [], remaining: 'unknown' } },
        'Stopped, may have happened',
        true,
      ],
      [
        { outcome: { status: 'cancelled-before-dispatch', effects: 'none' } },
        'Stopped before it began',
        false,
      ],
    ];
    for (const [fields, words, attention] of cases) {
      render(<AutomationCall record={call(fields)} loadFrames={noFrames} />);
      expect(screen.getByText(words).className).toContain('text-faint');
      const sign = signOf(title('Opened example.com/pricing'))?.getAttribute('class') ?? '';
      expect(sign.includes('text-wait')).toBe(attention);
      expect(sign.includes('lucide-circle-alert')).toBe(attention);
      expect(screen.queryByText('Failed')).toBeNull();
      cleanup();
    }
  });

  it('says what happened on the way, once each, each on a line of its own', () => {
    render(
      <AutomationCall
        record={call({
          toolName: 'browser_act',
          browserAction: { kind: 'click', label: 'Archive' },
          outcome: { status: 'dispatched', evidence: 'not-verified' },
          incidents: [
            {
              kind: 'dialog-dismissed',
              target: tab.ref,
              dialog: 'confirm',
              at: 1,
              operationId: null,
            },
            {
              kind: 'dialog-dismissed',
              target: tab.ref,
              dialog: 'alert',
              at: 2,
              operationId: null,
            },
            {
              kind: 'target-self-activated',
              target: tab.ref,
              cause: 'popup',
              at: 3,
              operationId: null,
            },
            { kind: 'secure-input', enabled: true, at: 4, operationId: null },
          ],
        })}
        loadFrames={noFrames}
      />,
    );
    const dialog = title('Dismissed a dialog the page opened');
    expect(screen.getAllByText('Dismissed a dialog the page opened')).toHaveLength(1);
    expect(dialog.parentElement?.textContent).toContain('No sharing');
    const front = title('example.com came to the front');
    expect(signOf(front)?.getAttribute('class')).toContain('text-wait');
    expect(screen.getByText('“Archive” opened its own window')).toBeDefined();
    const secure = title('Paused while a password field has the keyboard');
    expect(signOf(secure)?.getAttribute('class')).toContain('lucide-lock');
  });

  it('reads its screenshots once it shows, and again as it takes more', async () => {
    const loadFrames = vi.fn(() => Promise.resolve([shot]));
    const { rerender } = render(
      <AutomationCall
        record={call({ toolName: 'browser_screenshot', frames: [frame] })}
        loadFrames={loadFrames}
      />,
    );
    await settle();
    title('Took a screenshot of the page');
    const [thumbnail] = screen.getAllByRole('button', { name: /^Image / });
    expect(thumbnail?.className).toContain('border-dashed');
    expect(screen.getAllByRole('button', { name: /^Image / })).toHaveLength(1);
    rerender(
      <AutomationCall
        record={call({ toolName: 'browser_screenshot', frames: [frame], revision: 2 })}
        loadFrames={loadFrames}
      />,
    );
    await settle();
    expect(loadFrames).toHaveBeenCalledOnce();
    loadFrames.mockResolvedValue([shot, shot]);
    rerender(
      <AutomationCall
        record={call({ toolName: 'browser_screenshot', frames: [frame, frame], revision: 3 })}
        loadFrames={loadFrames}
      />,
    );
    await settle();
    expect(loadFrames).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('button', { name: /^Image / })).toHaveLength(2);
  });

  it('says when its screenshots are gone or could not be read, and reads none it has not taken', async () => {
    const loadFrames = vi.fn(() => Promise.reject(new Error('refused')));
    render(
      <AutomationCall
        record={call({ frames: [frame], framesState: 'evicted' })}
        loadFrames={loadFrames}
      />,
    );
    await settle();
    expect(screen.getByText('Its screenshots are no longer kept')).toBeDefined();
    expect(loadFrames).not.toHaveBeenCalled();
    cleanup();
    render(<AutomationCall record={call({ frames: [frame] })} loadFrames={loadFrames} />);
    await settle();
    expect(screen.getByText('Its screenshots couldn’t be read')).toBeDefined();
    cleanup();
    render(<AutomationCall record={call({})} loadFrames={loadFrames} />);
    await settle();
    expect(loadFrames).toHaveBeenCalledOnce();
  });
});
