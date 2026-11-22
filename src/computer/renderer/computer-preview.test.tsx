import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { Frame, Outcome, Preview } from '../../sessions/shared/automation';
import type { ComputerBridge } from '../shared/computer';
import {
  ComputerPreviewPanel,
  ComputerPreviewView,
  NO_APPLICATION_USE,
  type ApplicationUse,
} from './computer-preview';
import { useComputerPreview, type ComputerPreview } from './use-computer-preview';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const frame = (capturedAt: number): Frame => ({
  target: { id: 'window-1', kind: 'window', generation: 1 },
  observationId: 'o1',
  documentGeneration: null,
  geometryGeneration: 1,
  capturedAt,
  image: { mediaType: 'image/png', data: 'iVBORw0KGgo=' },
  imageSize: { width: 2, height: 2 },
  viewport: { x: 0, y: 0, width: 2, height: 2 },
  units: 'window-points',
  imageToViewport: [1, 0, 0, 1, 0, 0],
});
const shown = (capturedAt: number): Outcome<Preview> => ({
  status: 'verified',
  value: { status: 'frame', freshness: 'captured', frame: frame(capturedAt) },
});
const unavailable = (reason: 'permission-required' | 'application-quit'): Outcome<Preview> => ({
  status: 'verified',
  value: { status: 'unavailable', reason },
});
const busy: Outcome<Preview> = { status: 'refused', code: 'busy', dispatched: false };
const yes = () => Promise.resolve(true);

function port(answers: Outcome<Preview>[]) {
  const preview = vi.fn(() => Promise.resolve(answers.shift() ?? busy));
  const command = vi.fn((): Promise<Outcome<null>> =>
    Promise.resolve({ status: 'verified', value: null }),
  );
  return { preview, command } satisfies ComputerBridge;
}

function panel(preview: ComputerPreview, use: Partial<ApplicationUse> = {}, steps = {}) {
  const props = {
    onSwitch: vi.fn(yes),
    onStop: vi.fn(yes),
    onHandBack: vi.fn(yes),
    onAllow: vi.fn(yes),
    ...steps,
  };
  render(
    <ComputerPreviewPanel
      preview={preview}
      name="Mail"
      session="Reply to invoices"
      use={{ ...NO_APPLICATION_USE, ...use }}
      {...props}
    />,
  );
  return props;
}

describe('useComputerPreview', () => {
  it('asks at once and then each second, keeping the last frame while main is busy or cannot take one', async () => {
    vi.useFakeTimers();
    const main = port([shown(1), busy, unavailable('application-quit')]);
    const { result } = renderHook(() => useComputerPreview(main, 's1', 'p1', 'window-1'));
    expect(result.current.answered).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(main.preview).toHaveBeenCalledWith('s1', 'p1', 'window-1');
    expect(result.current.frame?.capturedAt).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(main.preview).toHaveBeenCalledTimes(2);
    expect(result.current.frame?.capturedAt).toBe(1);
    expect(result.current.unavailable).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current).toMatchObject({
      unavailable: 'application-quit',
      frame: { capturedAt: 1 },
    });
  });

  it('stops asking once its panel goes', async () => {
    vi.useFakeTimers();
    const main = port([shown(1)]);
    const { unmount } = renderHook(() => useComputerPreview(main, 's1', 'p1', 'window-1'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(main.preview).toHaveBeenCalledOnce();
  });
});

describe('ComputerPreviewPanel', () => {
  it('says it is loading until the first frame comes, then shows the frame faded, and how old it is', () => {
    panel({ answered: false, frame: null, unavailable: null });
    expect(screen.getByText('Loading preview…')).toBeDefined();
    expect(screen.getByText('Preview · not interactive')).toBeDefined();
    cleanup();
    panel({
      answered: true,
      frame: { image: frame(1).image, capturedAt: Date.now() - 2_000 },
      unavailable: null,
    });
    expect(screen.getByRole('img', { name: 'Mail’s window' }).className).toContain('saturate-60');
    expect(screen.getByText('Preview · not interactive · 2 s ago')).toBeDefined();
  });

  it('shows the step that allows Screen Recording until it is allowed', () => {
    const steps = panel({ answered: true, frame: null, unavailable: 'permission-required' });
    expect(screen.getByText('Showing Mail needs Screen Recording')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }));
    expect(steps.onAllow).toHaveBeenCalledOnce();
  });

  it('shows a window that cannot be taken by its name and why, or by its last frame', () => {
    panel({ answered: true, frame: null, unavailable: 'application-quit' });
    expect(screen.getByText('Mail has quit')).toBeDefined();
    cleanup();
    panel({
      answered: true,
      frame: { image: frame(1).image, capturedAt: Date.now() - 180_000 },
      unavailable: 'target-state-unsupported',
    });
    expect(screen.getByRole('img', { name: 'Mail’s window' })).toBeDefined();
    expect(screen.getByText('Preview · not interactive · 3 min ago')).toBeDefined();
  });

  it('brings the application forward with Switch to, and names the session while it acts, with Stop, or the user’s control, with Hand Back', async () => {
    const steps = panel(
      { answered: true, frame: null, unavailable: null },
      { held: true, acting: true },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Mail' }));
    expect(steps.onSwitch).toHaveBeenCalledOnce();
    expect(screen.getByText('Reply to invoices is acting in Mail')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(steps.onStop).toHaveBeenCalledOnce();
    cleanup();
    const taken = panel(
      { answered: true, frame: null, unavailable: null },
      { held: true, userHas: true },
      { onHandBack: vi.fn(() => Promise.resolve(false)) },
    );
    expect(screen.getByText('You have control of Mail')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Hand Back' }));
    await act(() => Promise.resolve());
    expect(taken.onHandBack).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').textContent).toBe('That didn’t work.');
  });

  it('sends Switch to and Hand Back through its presentation', async () => {
    vi.useFakeTimers();
    const main = port([shown(Date.now())]);
    render(
      <ComputerPreviewView
        port={main}
        owner="s1"
        presentation="p1"
        target="window-1"
        name="Mail"
        session="Reply to invoices"
        use={{ ...NO_APPLICATION_USE, held: true, userHas: true }}
        onStop={yes}
        onAllow={yes}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Mail' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hand Back' }));
    expect(main.command.mock.calls).toEqual([
      ['s1', 'p1', 'window-1', 'reveal'],
      ['s1', 'p1', 'window-1', 'hand-back'],
    ]);
  });
});
