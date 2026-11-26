import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { ModelOption, SessionEvent } from '../shared/events';
import { initialSessionState, type SessionState } from '../shared/session-state';
import type {
  SessionEventsListener,
  SessionsBridge,
  SessionSnapshot,
  SessionSummary,
} from '../shared/sessions';
import { SessionPage } from './session-page';
import { preloadOffers } from './use-offers';

// Images read as the composer takes them, without a canvas, which the test's document lacks: every
// PNG becomes the same small one, and a TIFF is refused.
vi.mock('./image-input', () => ({
  readImage: (file: Blob) =>
    Promise.resolve(
      file.type === 'image/tiff'
        ? { refused: 'type' }
        : { mediaType: file.type, data: 'iVBORw0KGgo=' },
    ),
  pngOf: (image: unknown) => Promise.resolve(image),
}));

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// A bridge to sessions in the main process, whose answers the test sets, and whose events it sends.
function fakeBridge(state: SessionState | null = null) {
  const listeners = new Set<SessionEventsListener>();
  const bridge = {
    list: () => Promise.resolve({ sessions: [], archived: 0, shown: [] }),
    onChange: () => () => undefined,
    archived: () => Promise.resolve([]),
    resume: vi.fn<SessionsBridge['resume']>(() => Promise.resolve()),
    showMenu: vi.fn<SessionsBridge['showMenu']>(() => Promise.resolve(null)),
    act: vi.fn<SessionsBridge['act']>(() => Promise.resolve(null)),
    search: vi.fn<SessionsBridge['search']>(() => Promise.resolve({ matches: [], unread: 0 })),
    providers: () => Promise.resolve(['claude-code' as const, 'codex' as const]),
    dayFolder: () => Promise.resolve('/Users/me/3mukon-code/2026-10-28'),
    gateways: vi.fn<SessionsBridge['gateways']>((provider) =>
      Promise.resolve(provider === 'claude-code' ? ['work'] : []),
    ),
    models: vi.fn<SessionsBridge['models']>(() =>
      Promise.resolve([{ id: 'opus', label: 'Opus', efforts: ['high', 'max'] }]),
    ),
    choices: vi.fn<SessionsBridge['choices']>(() =>
      Promise.resolve({ folders: {}, dayRoot: '/Users/me/3mukon-code' }),
    ),
    rememberChoice: vi.fn<SessionsBridge['rememberChoice']>(() => Promise.resolve()),
    confirmYolo: vi.fn<SessionsBridge['confirmYolo']>(() => Promise.resolve(false)),
    start: vi.fn<SessionsBridge['start']>(() => Promise.resolve('s1')),
    send: vi.fn<SessionsBridge['send']>(() => Promise.resolve()),
    interrupt: vi.fn<SessionsBridge['interrupt']>(() => Promise.resolve()),
    setMode: vi.fn<SessionsBridge['setMode']>(() => Promise.resolve(true)),
    setGateway: vi.fn<SessionsBridge['setGateway']>(() => Promise.resolve()),
    setModel: vi.fn<SessionsBridge['setModel']>(() => Promise.resolve()),
    setEffort: vi.fn<SessionsBridge['setEffort']>(() => Promise.resolve()),
    setSandbox: vi.fn<SessionsBridge['setSandbox']>(() => Promise.resolve()),
    snapshot: vi.fn<SessionsBridge['snapshot']>(() =>
      Promise.resolve(state === null ? null : { seq: 1, state }),
    ),
    preload: vi.fn<SessionsBridge['preload']>(() => Promise.resolve()),
    onEvent: (listener: SessionEventsListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    copyText: vi.fn<SessionsBridge['copyText']>(() => Promise.resolve()),
    copyImage: vi.fn<SessionsBridge['copyImage']>(() => Promise.resolve()),
    saveImage: vi.fn<SessionsBridge['saveImage']>(() => Promise.resolve(true)),
    imageMenu: vi.fn<SessionsBridge['imageMenu']>(() => Promise.resolve(null)),
  } satisfies SessionsBridge;
  const emit = (seq: number, event: SessionEvent) => {
    act(() => {
      for (const listener of listeners) listener('s1', seq, event);
    });
  };
  return { bridge, emit };
}

const settle = () => act(() => Promise.resolve());
const choose = (name: string, value: string) => {
  fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
};
const composer = () => screen.getByRole('textbox', { name: 'Message' });
const chooser = (name: string) => screen.getByRole<HTMLSelectElement>('combobox', { name });
const options = (name: string) =>
  [...chooser(name).options].map((option) => [option.value, option.textContent]);
const page = (bridge: SessionsBridge) => (
  <SessionPage bridge={bridge} folder="/Users/me/web" sessionId={null} onStarted={vi.fn()} />
);

// Models as a provider lists them: its own default, with an effort of its own beside medium, a model
// without medium, one that names no default effort, and one that takes no effort.
const MODELS: ModelOption[] = [
  {
    id: 'sol',
    label: 'Sol',
    efforts: ['low', 'medium', 'high'],
    default: true,
    defaultEffort: 'high',
  },
  { id: 'luna', label: 'Luna', efforts: ['low', 'high'], defaultEffort: 'low' },
  { id: 'terra', label: 'Terra', efforts: ['low', 'max'] },
  { id: 'mono', label: 'Mono', efforts: [] },
];

describe('SessionPage', () => {
  it('marks a provider not signed in among the choices, offers its sign-in and shows its usage notice beside the context', async () => {
    const { bridge, emit } = fakeBridge({ ...initialSessionState(), mode: 'auto' });
    const accounts = {
      signedOut: (provider: string) => provider === 'codex',
      signedIn: (provider: string) => provider === 'claude-code',
      notInstalled: () => false,
      downloading: () => false,
      signIn: (provider: string) => <p>Sign in to {provider}</p>,
      notice: (provider: string) =>
        provider === 'claude-code' ? <span>Nearly used up</span> : null,
    };
    const shown = (sessionId: string | null) => (
      <SessionPage
        bridge={bridge}
        folder="/Users/me/web"
        sessionId={sessionId}
        onStarted={vi.fn()}
        accounts={accounts}
      />
    );
    const { rerender } = render(shown(null));
    await settle();
    expect(options('Provider')).toEqual([
      ['claude-code', 'Claude Code'],
      ['codex', 'Codex CLI (not signed in)'],
    ]);
    expect(screen.queryByText(/Sign in to/)).toBeNull();
    expect(screen.getByText('Nearly used up')).toBeTruthy();
    choose('Provider', 'codex');
    await settle();
    expect(screen.getByText('Sign in to codex')).toBeTruthy();
    expect(screen.queryByText('Nearly used up')).toBeNull();
    choose('Provider', 'claude-code');
    await settle();
    rerender(shown('s1'));
    await settle();
    emit(2, { type: 'context', used: 30_000, size: 200_000 });
    // The notice comes just before the context in use, near the divider's end.
    const context = screen.getByText('30k / 200k (15.0%)');
    expect(screen.getByText('Nearly used up').nextElementSibling).toBe(context);
  });

  it('names the provider first in the one button that holds the settings in a narrow panel, then a chosen gateway', async () => {
    // The row of settings is wider than the panel; the test environment lays out nothing.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    const { bridge } = fakeBridge();
    render(page(bridge));
    await settle();
    const button = screen.getByRole('button', { name: /^Session settings: / });
    expect(button.textContent).toMatch(/^Claude Code · /);
    expect(button.textContent).not.toContain('No gateway');
    const dropdown = document.getElementById(button.getAttribute('popovertarget') ?? '');
    if (dropdown === null) throw new Error('no dropdown');
    fireEvent.change(within(dropdown).getByRole('combobox', { name: 'Gateway' }), {
      target: { value: 'work' },
    });
    await settle();
    expect(button.textContent).toMatch(/^Claude Code · work · /);
    cleanup();

    const { bridge: running } = fakeBridge({ ...initialSessionState(), mode: 'auto' });
    render(
      <SessionPage
        bridge={running}
        folder="/Users/me/web"
        sessionId="s1"
        summary={{
          id: 's1',
          provider: 'codex',
          sessionId: 'p1',
          cwd: '/Users/me/web',
          status: 'idle',
          activeAt: 0,
        }}
        onStarted={vi.fn()}
      />,
    );
    await settle();
    expect(screen.getByRole('button', { name: /^Session settings: / }).textContent).toMatch(
      /^Codex CLI · /,
    );
  });

  it('chooses the session’s settings before its first message, and starts it with that message', async () => {
    const { bridge } = fakeBridge();
    const onStarted = vi.fn();
    const { rerender } = render(
      <SessionPage bridge={bridge} folder="/Users/me/web" sessionId={null} onStarted={onStarted} />,
    );
    await settle();
    // A gateway appears for a provider that has gateways, and effort for a model that takes it.
    choose('Gateway', 'work');
    await settle();
    expect(bridge.models.mock.calls.at(-1)).toEqual(['claude-code', 'work', '/Users/me/web', true]);
    choose('Model', 'opus');
    choose('Reasoning effort', 'max');
    choose('Sandbox', 'read-only');
    fireEvent.change(composer(), { target: { value: 'Fix the build\n' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(bridge.start.mock.calls).toEqual([
      [
        {
          provider: 'claude-code',
          gateway: 'work',
          model: 'opus',
          effort: 'max',
          mode: 'auto',
          sandbox: 'read-only',
          cwd: '/Users/me/web',
          message: 'Fix the build',
          images: [],
        },
      ],
    ]);
    // The message shows as the prompt while the session starts.
    expect(screen.getByText('Fix the build')).toBeDefined();
    await settle();
    expect(onStarted.mock.calls).toEqual([['s1']]);

    // As the page goes on as the session's own, it shows the settings the session started with
    // until the session's state comes, and the message still.
    bridge.snapshot.mockReturnValueOnce(new Promise(() => undefined));
    rerender(
      <SessionPage bridge={bridge} folder="/Users/me/web" sessionId="s1" onStarted={onStarted} />,
    );
    await settle();
    expect(screen.getByText('Fix the build')).toBeDefined();
    expect(chooser('Model').value).toBe('opus');
    expect(chooser('Reasoning effort').value).toBe('max');
    expect(chooser('Sandbox').value).toBe('read-only');
    expect(chooser('Sandbox').closest('.invisible')).toBeNull();
  });

  it('shows nothing of the settings of a session it has not started until the session’s state comes', async () => {
    const { bridge } = fakeBridge();
    let found: (snapshot: SessionSnapshot | null) => void = () => undefined;
    bridge.snapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        found = resolve;
      }),
    );
    render(
      <SessionPage bridge={bridge} folder="/Users/me/web" sessionId="s1" onStarted={vi.fn()} />,
    );
    await settle();
    expect(chooser('Sandbox').closest('.invisible')).not.toBeNull();
    await act(async () => {
      found({
        seq: 1,
        state: { ...initialSessionState(true), closed: true, sandbox: 'read-only' },
      });
      await Promise.resolve();
    });
    expect(chooser('Sandbox').closest('.invisible')).toBeNull();
    expect(chooser('Sandbox').value).toBe('read-only');
    // That the history is still being read is said only once that has taken a while, which the
    // notice's animation waits for.
    expect(screen.getByText('Reading the session’s history…').className).toContain(
      'animate-appear',
    );
  });

  it('renders a long history’s last items first, as many as fill the view, and the rest behind them', async () => {
    // A view 1,000 pixels tall, and items 30 pixels tall; the test environment lays out nothing.
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(1_000);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.childElementCount * 30;
    });
    const { bridge } = fakeBridge({
      ...initialSessionState(),
      closed: true,
      timeline: Array.from({ length: 100 }, (_, index) => ({
        type: 'message' as const,
        id: `m${String(index)}`,
        role: 'user' as const,
        text: `Step ${String(index)}`,
      })),
    });
    vi.useFakeTimers();
    try {
      render(
        <SessionPage bridge={bridge} folder="/Users/me/web" sessionId="s1" onStarted={vi.fn()} />,
      );
      await settle();
      // 24 items leave the view room, so 48 show at first, the last of them.
      expect(screen.queryByText('Step 51')).toBeNull();
      expect(screen.getByText('Step 52')).toBeDefined();
      expect(screen.getByText('Step 99')).toBeDefined();
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(screen.getByText('Step 0')).toBeDefined();
      expect(screen.getByText('Step 99')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the end of the activity in view as it changes size after it renders, until the user scrolls up', async () => {
    const resized: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized.push(callback);
        }
        observe() {
          return undefined;
        }
        disconnect() {
          return undefined;
        }
      },
    );
    try {
      const { bridge } = fakeBridge({ ...initialSessionState(), mode: 'auto' });
      render(
        <SessionPage bridge={bridge} folder="/Users/me/web" sessionId="s1" onStarted={vi.fn()} />,
      );
      await settle();
      const activity = screen.getByRole('region', { name: 'Activity' });
      const grow = (height: number) => {
        Object.defineProperty(activity, 'scrollHeight', { configurable: true, value: height });
        Object.defineProperty(activity, 'clientHeight', { configurable: true, value: 300 });
        act(() => {
          for (const callback of resized) callback();
        });
      };
      grow(900);
      expect(activity.scrollTop).toBe(900);
      activity.scrollTop = 100;
      fireEvent.scroll(activity);
      grow(1_200);
      expect(activity.scrollTop).toBe(100);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('starts on the provider’s default model, under its own name, at medium effort', async () => {
    const { bridge } = fakeBridge();
    bridge.models.mockResolvedValue(MODELS);
    render(page(bridge));
    await settle();
    expect(options('Model')).toEqual([
      ['', 'Sol'],
      ['luna', 'Luna'],
      ['terra', 'Terra'],
      ['mono', 'Mono'],
    ]);
    expect(chooser('Model').value).toBe('');
    // Medium, although the model's own default is high; each level with a capital, as the other
    // settings have.
    expect(options('Reasoning effort')).toEqual([
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
    ]);
    expect(chooser('Reasoning effort').value).toBe('medium');
    fireEvent.change(composer(), { target: { value: 'Hi' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(bridge.start.mock.calls[0]?.[0]).toMatchObject({ model: null, effort: 'medium' });
  });

  it('takes a model’s own default effort where it has no medium, and its level nearest medium where it names none', async () => {
    const { bridge } = fakeBridge();
    bridge.models.mockResolvedValue(MODELS);
    render(page(bridge));
    await settle();
    choose('Model', 'luna');
    expect(options('Reasoning effort')).toEqual([
      ['low', 'Low'],
      ['high', 'High'],
    ]);
    expect(chooser('Reasoning effort').value).toBe('low');
    choose('Model', 'terra');
    expect(options('Reasoning effort')).toEqual([
      ['low', 'Low'],
      ['max', 'Max'],
    ]);
    expect(chooser('Reasoning effort').value).toBe('low');
    choose('Model', 'mono');
    expect(screen.queryByRole('combobox', { name: 'Reasoning effort' })).toBeNull();
  });

  it('says it is loading the models until they come, has those found ahead of time at once, and then its folder’s', async () => {
    const { bridge } = fakeBridge();
    let answer: (models: ModelOption[]) => void = () => undefined;
    bridge.models.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    render(page(bridge));
    await settle();
    expect(screen.getByText('Loading models…')).toBeDefined();
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
    act(() => {
      answer(MODELS);
    });
    await settle();
    expect(chooser('Model').value).toBe('');
    expect(screen.queryByText('Loading models…')).toBeNull();
    cleanup();

    // Asked for as the window opens, the lists are there as a page first shows.
    const ahead = fakeBridge().bridge;
    ahead.models.mockResolvedValue(MODELS);
    preloadOffers(ahead);
    await settle();
    expect(ahead.models.mock.calls).toEqual([
      ['claude-code', null, null, false],
      ['codex', null, null, false],
    ]);
    // The page asks for its folder's models as they are now, where another model may be the default,
    // and shows those found ahead of time until they come.
    ahead.models.mockResolvedValue(
      MODELS.map((model) => ({ ...model, default: model.id === 'luna' })),
    );
    render(page(ahead));
    expect(options('Model')[0]).toEqual(['', 'Sol']);
    expect(chooser('Reasoning effort').value).toBe('medium');
    expect(options('Gateway')).toEqual([
      ['', 'No gateway'],
      ['work', 'work'],
    ]);
    await settle();
    expect(ahead.models.mock.calls.at(-1)).toEqual(['claude-code', null, '/Users/me/web', true]);
    expect(options('Model').slice(0, 2)).toEqual([
      ['sol', 'Sol'],
      ['', 'Luna'],
    ]);
  });

  it('starts a page with a provider the user is signed in to rather than Claude Code, and keeps it once the user types', async () => {
    const { bridge } = fakeBridge();
    const views = (signedIn: string[], signedOut: string[] = []) => ({
      signedOut: (provider: string) => signedOut.includes(provider),
      signedIn: (provider: string) => signedIn.includes(provider),
      notInstalled: () => false,
      downloading: () => false,
      signIn: () => null,
      notice: () => null,
    });
    const shown = (accounts: ReturnType<typeof views>) => (
      <SessionPage
        bridge={bridge}
        folder="/Users/me/web"
        sessionId={null}
        onStarted={vi.fn()}
        accounts={accounts}
      />
    );
    // Before the app knows any sign-in, Claude Code; once it learns one, a page the user has not
    // touched takes it.
    const { rerender } = render(shown(views([])));
    await settle();
    expect(chooser('Provider').value).toBe('claude-code');
    rerender(shown(views(['codex'], ['claude-code'])));
    await settle();
    expect(chooser('Provider').value).toBe('codex');
    // Signed in to both, the provider menu's order: Claude Code first.
    rerender(shown(views(['claude-code', 'codex'])));
    await settle();
    expect(chooser('Provider').value).toBe('claude-code');
    // Once the user types, a sign-in learnt later changes nothing.
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Hi' } });
    rerender(shown(views(['codex'], ['claude-code'])));
    await settle();
    expect(chooser('Provider').value).toBe('claude-code');
  });

  it('gives way from a remembered provider known to be signed out to a signed-in one, with its own defaults, and keeps one whose sign-in is unknown', async () => {
    const { bridge } = fakeBridge();
    bridge.models.mockResolvedValue(MODELS);
    bridge.choices.mockResolvedValue({
      folders: {
        '/Users/me/web': {
          provider: 'codex',
          gateway: null,
          model: 'luna',
          effort: 'high',
          sandbox: 'read-only',
        },
      },
      dayRoot: '/Users/me/3mukon-code',
    });
    const accounts = (codex: 'signed-out' | 'unknown') => ({
      signedOut: (provider: string) => provider === 'codex' && codex === 'signed-out',
      signedIn: (provider: string) => provider === 'claude-code',
      notInstalled: () => false,
      downloading: () => false,
      signIn: () => null,
      notice: () => null,
    });
    const { rerender } = render(
      <SessionPage
        bridge={bridge}
        folder="/Users/me/web"
        sessionId={null}
        onStarted={vi.fn()}
        accounts={accounts('signed-out')}
      />,
    );
    await settle();
    expect(chooser('Provider').value).toBe('claude-code');
    expect(chooser('Model').value).toBe('');
    expect(chooser('Sandbox').value).toBe('read-only');
    rerender(
      <SessionPage
        bridge={bridge}
        folder="/Users/me/web"
        sessionId={null}
        onStarted={vi.fn()}
        accounts={accounts('unknown')}
      />,
    );
    await settle();
    expect(chooser('Provider').value).toBe('codex');
    expect(chooser('Model').value).toBe('luna');
  });

  it('starts with the settings the folder’s sessions last used, but in auto, and remembers its own', async () => {
    const { bridge } = fakeBridge();
    bridge.models.mockResolvedValue(MODELS);
    bridge.choices.mockResolvedValue({
      folders: {
        '/Users/me/web': {
          provider: 'codex',
          gateway: null,
          model: 'luna',
          effort: 'high',
          sandbox: 'read-only',
        },
      },
      dayRoot: '/Users/me/3mukon-code',
    });
    render(page(bridge));
    await settle();
    expect(chooser('Provider').value).toBe('codex');
    expect(chooser('Model').value).toBe('luna');
    expect(chooser('Reasoning effort').value).toBe('high');
    expect(chooser('Permission mode').value).toBe('auto');
    expect(chooser('Sandbox').value).toBe('read-only');
    const message = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(message, { target: { value: 'Hi' } });
    fireEvent.keyDown(message, { key: 'Enter' });
    expect(bridge.start.mock.calls[0]?.[0]).toMatchObject({
      provider: 'codex',
      model: 'luna',
      effort: 'high',
      mode: 'auto',
      sandbox: 'read-only',
    });
    await settle();
    expect(bridge.rememberChoice.mock.calls).toEqual([
      [
        '/Users/me/web',
        { provider: 'codex', gateway: null, model: 'luna', effort: 'high', sandbox: 'read-only' },
      ],
    ]);
  });

  it('lets a remembered model or effort that is no longer offered give way to the default', async () => {
    const { bridge } = fakeBridge();
    bridge.models.mockResolvedValue(MODELS);
    bridge.choices.mockResolvedValue({
      folders: {
        '/Users/me/web': {
          provider: 'claude-code',
          gateway: null,
          model: 'gone',
          effort: 'ultra',
          sandbox: 'workspace-write',
        },
      },
      dayRoot: '/Users/me/3mukon-code',
    });
    render(page(bridge));
    await settle();
    expect(chooser('Model').value).toBe('');
    expect(chooser('Reasoning effort').value).toBe('medium');
    fireEvent.change(composer(), { target: { value: 'Hi' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(bridge.start.mock.calls[0]?.[0]).toMatchObject({ model: null, effort: 'medium' });
  });

  it('asks before yolo, and keeps auto when the user does not confirm', async () => {
    const { bridge } = fakeBridge();
    render(
      <SessionPage bridge={bridge} folder="/Users/me/web" sessionId={null} onStarted={vi.fn()} />,
    );
    await settle();
    choose('Permission mode', 'yolo');
    await settle();
    expect(bridge.confirmYolo).toHaveBeenCalledOnce();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Permission mode' }).value).toBe(
      'auto',
    );
    bridge.confirmYolo.mockResolvedValue(true);
    choose('Permission mode', 'yolo');
    await settle();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Permission mode' }).value).toBe(
      'yolo',
    );
  });

  it('sends the images pasted into the composer or dropped on it, each of which it can take out', async () => {
    const { bridge } = fakeBridge();
    render(page(bridge));
    await settle();
    const shot = new File(['png'], 'shot.png', { type: 'image/png' });
    // A paste of images alone pastes no text; a drop of images stays in the composer.
    expect(
      fireEvent.paste(composer(), { clipboardData: { files: [shot], getData: () => '' } }),
    ).toBe(false);
    await settle();
    const outside = vi.fn();
    document.addEventListener('drop', outside);
    const zone = composer().closest('.mx-5');
    if (zone === null) throw new Error('No composer.');
    const transfer = {
      items: [{ kind: 'file', type: 'image/png' }],
      files: [shot],
      dropEffect: '',
    };
    expect(fireEvent.dragOver(zone, { dataTransfer: transfer })).toBe(false);
    expect(fireEvent.drop(zone, { dataTransfer: transfer })).toBe(false);
    await settle();
    document.removeEventListener('drop', outside);
    expect(outside).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: /^Image \d$/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Image 2' }));
    // A message of images alone goes too.
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(bridge.start.mock.calls[0]?.[0]).toMatchObject({
      message: '',
      images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
    });
    expect(screen.queryByRole('button', { name: 'Remove Image 1' })).toBeNull();
  });

  it('says why an image cannot go with the message', async () => {
    const { bridge } = fakeBridge();
    render(page(bridge));
    await settle();
    const scan = new File(['tiff'], 'scan.tiff', { type: 'image/tiff' });
    fireEvent.paste(composer(), { clipboardData: { files: [scan], getData: () => 'scan' } });
    await settle();
    expect(screen.getByRole('status').textContent).toBe(
      'Only PNG, JPEG, GIF and WebP images can be sent.',
    );
    expect(screen.queryByRole('button', { name: 'Image 1' })).toBeNull();
  });

  it('leaves Shift-Return to a new line, and shows that a session could not start', async () => {
    const { bridge } = fakeBridge();
    bridge.start.mockRejectedValue(new Error('Not signed in.'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <SessionPage bridge={bridge} folder="/Users/me/web" sessionId={null} onStarted={vi.fn()} />,
    );
    await settle();
    fireEvent.change(composer(), { target: { value: 'Hi' } });
    expect(fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true })).toBe(true);
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await settle();
    expect(screen.getByText('The session couldn’t start.')).toBeDefined();
    // The message comes back to the composer.
    expect(composer()).toHaveProperty('value', 'Hi');
  });

  it('shows a session that is not running with the settings it last had, yolo too, and resumes it with the next message', async () => {
    const { bridge, emit } = fakeBridge({
      ...initialSessionState(true),
      closed: true,
      mode: 'yolo',
      gateway: null,
      model: 'opus',
      effort: 'max',
      sandbox: 'read-only',
    });
    const summary: SessionSummary = {
      id: 's1',
      provider: 'claude-code',
      sessionId: 'p1',
      cwd: '/Users/me/web',
      title: 'Fix the build',
      status: 'closed',
      activeAt: 1,
    };
    const onStarted = vi.fn();
    render(
      <SessionPage
        bridge={bridge}
        folder="/Users/me/web"
        sessionId="s1"
        summary={summary}
        onStarted={onStarted}
      />,
    );
    await settle();
    expect(screen.getByText('Reading the session’s history…')).toBeDefined();
    // A session's page asks for no list of its folder's own.
    expect(bridge.models.mock.calls.filter((call) => call[2] !== null || call[3])).toEqual([]);
    emit(2, {
      type: 'history',
      events: [{ type: 'message', id: 'm1', role: 'user', text: 'Fix the build' }],
    });
    expect(screen.queryByText('Reading the session’s history…')).toBeNull();
    expect(screen.getByText('Fix the build')).toBeDefined();
    // Its settings show as it last had them, and change without switching anything.
    expect(screen.getByText('Claude Code')).toBeDefined();
    expect(chooser('Permission mode').value).toBe('yolo');
    expect(chooser('Sandbox').value).toBe('read-only');
    expect(chooser('Reasoning effort').value).toBe('max');
    choose('Sandbox', 'workspace-write');
    choose('Reasoning effort', 'high');
    expect(bridge.setSandbox).not.toHaveBeenCalled();
    expect(bridge.setEffort).not.toHaveBeenCalled();
    expect(chooser('Sandbox').value).toBe('workspace-write');
    let resumed: () => void = () => undefined;
    bridge.resume.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resumed = resolve;
        }),
    );
    fireEvent.change(composer(), { target: { value: 'And the tests' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(bridge.resume.mock.calls).toEqual([
      [
        's1',
        {
          mode: 'yolo',
          gateway: null,
          model: 'opus',
          effort: 'high',
          sandbox: 'workspace-write',
          message: 'And the tests',
          images: [],
        },
      ],
    ]);
    expect(bridge.send).not.toHaveBeenCalled();
    // The message shows after the history while the session resumes.
    expect(screen.getByText('And the tests')).toBeDefined();
    expect(screen.getByText('Working')).toBeDefined();
    expect(composer()).toHaveProperty('value', '');
    emit(3, { type: 'resumed' });
    await act(async () => {
      resumed();
      await Promise.resolve();
    });
    expect(bridge.rememberChoice.mock.calls).toEqual([
      [
        '/Users/me/web',
        {
          provider: 'claude-code',
          gateway: null,
          model: 'opus',
          effort: 'high',
          sandbox: 'workspace-write',
        },
      ],
    ]);
    // Running again, it shows its own settings, and a change switches it.
    emit(4, { type: 'settings', sandbox: 'workspace-write', effort: 'high' });
    choose('Sandbox', 'read-only');
    expect(bridge.setSandbox.mock.calls).toEqual([['s1', 'read-only']]);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('asks before yolo for a session that is not running, and says when it could not be resumed', async () => {
    const { bridge, emit } = fakeBridge({ ...initialSessionState(), closed: true, mode: 'auto' });
    bridge.confirmYolo.mockResolvedValueOnce(true);
    bridge.resume.mockRejectedValueOnce(new Error('Not signed in.'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <SessionPage bridge={bridge} folder="/Users/me/web" sessionId="s1" onStarted={vi.fn()} />,
    );
    await settle();
    emit(2, { type: 'history', events: [], failed: true });
    expect(screen.getByText('The session’s history couldn’t be read.')).toBeDefined();
    choose('Permission mode', 'yolo');
    await settle();
    expect(bridge.confirmYolo).toHaveBeenCalledOnce();
    expect(bridge.setMode).not.toHaveBeenCalled();
    expect(chooser('Permission mode').value).toBe('yolo');
    fireEvent.change(composer(), { target: { value: 'Go on' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await settle();
    expect(bridge.resume.mock.calls[0]?.[1]).toMatchObject({ mode: 'yolo', message: 'Go on' });
    expect(screen.getByText('The session couldn’t be resumed.')).toBeDefined();
    expect(screen.queryByText('Working')).toBeNull();
    // The message comes back to the composer, and the choice stays.
    expect(composer()).toHaveProperty('value', 'Go on');
    expect(chooser('Permission mode').value).toBe('yolo');
  });

  it('shows the session’s approvals and questions as its composer renders them', async () => {
    const { bridge } = fakeBridge({
      ...initialSessionState(),
      turnRunning: true,
      mode: 'auto',
      timeline: [
        {
          type: 'approval',
          request: {
            id: 'r1',
            action: 'command',
            command: 'pnpm test',
            canAllowForSession: true,
            denyByDefault: false,
            requestedAt: 0,
          },
        },
      ],
    });
    render(
      <SessionPage
        bridge={bridge}
        folder="/Users/me/web"
        sessionId="s1"
        summary={{
          id: 's1',
          provider: 'codex',
          sessionId: 'p1',
          cwd: '/Users/me/web',
          status: 'waiting',
          activeAt: 0,
        }}
        onStarted={vi.fn()}
        renderRequest={(item) => <p>{`${item.type} ${item.request.id}`}</p>}
      />,
    );
    await settle();
    screen.getByText('approval r1');
  });

  it('shows a running session’s activity, sends and stops it, and switches its settings', async () => {
    const running: SessionState = {
      ...initialSessionState(),
      turnRunning: true,
      mode: 'auto',
      sandbox: 'workspace-write',
      timeline: [{ type: 'message', id: 'm1', role: 'user', text: 'Fix the build' }],
      tasks: [{ text: 'Run the tests', status: 'in_progress' }],
    };
    const { bridge, emit } = fakeBridge(running);
    render(
      <SessionPage
        bridge={bridge}
        folder="/Users/me/web"
        sessionId="s1"
        summary={{
          id: 's1',
          provider: 'claude-code',
          sessionId: 'p1',
          cwd: '/Users/me/web',
          status: 'running',
          activeAt: 0,
        }}
        onStarted={vi.fn()}
      />,
    );
    await settle();
    expect(screen.getByText('Fix the build')).toBeDefined();
    expect(screen.getByText('Run the tests')).toBeDefined();
    expect(screen.getByText('Working')).toBeDefined();
    // The provider stays as chosen.
    expect(screen.queryByRole('combobox', { name: 'Provider' })).toBeNull();
    // A message sent during the turn goes to the session at once.
    fireEvent.change(composer(), { target: { value: 'Also fix the lint' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(bridge.send.mock.calls).toEqual([['s1', 'Also fix the lint', []]]);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(bridge.interrupt.mock.calls).toEqual([['s1']]);
    choose('Permission mode', 'yolo');
    choose('Sandbox', 'full-access');
    expect(bridge.setMode.mock.calls).toEqual([['s1', 'yolo']]);
    expect(bridge.setSandbox.mock.calls).toEqual([['s1', 'full-access']]);
    // A switch that has taken is remembered for the folder; the permission mode is not.
    await settle();
    expect(bridge.rememberChoice.mock.calls).toEqual([
      [
        '/Users/me/web',
        {
          provider: 'claude-code',
          gateway: null,
          model: null,
          effort: null,
          sandbox: 'full-access',
        },
      ],
    ]);
    // How much of the context the conversation takes shows at the composer's end.
    emit(2, { type: 'context', used: 30_000, size: 200_000 });
    // In whole thousands, with the exact numbers in its tooltip.
    expect(screen.getByText('30k / 200k (15.0%)').title).toBe(
      '30,000 of 200,000 tokens of the context window in use (15.0%)',
    );
    emit(3, { type: 'context', used: 1_234_400, size: null });
    expect(screen.getByText('1,234k tokens of context').title).toBe('1,234,400 tokens of context');
    // The turn ends; the next message goes to the session.
    emit(4, { type: 'message', id: 'm2', role: 'agent', text: 'Done: **all green**.' });
    emit(5, { type: 'turn-ended', outcome: 'completed' });
    expect(screen.getByText('all green').tagName).toBe('STRONG');
    expect(screen.queryByText('Working')).toBeNull();
    fireEvent.change(composer(), { target: { value: 'Thanks' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(bridge.send.mock.calls.at(-1)).toEqual(['s1', 'Thanks', []]);
  });
});

describe('SessionPage’s reasoning effort', () => {
  // A running session of a provider that names no model's default effort, as Claude Code does.
  const runningAt = (effort: string | null): SessionState => ({
    ...initialSessionState(),
    mode: 'auto',
    sandbox: 'workspace-write',
    model: 'opus',
    effort,
    models: [
      { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'max'], default: true },
    ],
    timeline: [{ type: 'message', id: 'm1', role: 'user', text: 'Fix the build' }],
  });
  const running = (state: SessionState) => {
    const { bridge } = fakeBridge(state);
    render(
      <SessionPage
        bridge={bridge}
        folder="/Users/me/web"
        sessionId="s1"
        summary={{
          id: 's1',
          provider: 'claude-code',
          sessionId: 'p1',
          cwd: '/Users/me/web',
          status: 'idle',
          activeAt: 0,
        }}
        onStarted={vi.fn()}
      />,
    );
    return bridge;
  };

  it('offers a running session the model’s levels alone, never a default', async () => {
    const bridge = running(runningAt('high'));
    await settle();
    expect(options('Reasoning effort')).toEqual([
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
      ['max', 'Max'],
    ]);
    expect(chooser('Reasoning effort').value).toBe('high');
    choose('Reasoning effort', 'low');
    expect(bridge.setEffort.mock.calls).toEqual([['s1', 'low']]);
  });

  it('shows the starting effort for a session without one whose provider names no default', async () => {
    running(runningAt(null));
    await settle();
    expect(options('Reasoning effort').map(([value]) => value)).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(chooser('Reasoning effort').value).toBe('medium');
  });
});

describe('SessionPage’s lines above the composer', () => {
  it('shows the lines it is given above the composer’s divider', async () => {
    const { bridge } = fakeBridge();
    render(
      <SessionPage
        bridge={bridge}
        folder="/Users/me/web"
        sessionId={null}
        onStarted={vi.fn()}
        aboveComposer={<p>Using example.com</p>}
      />,
    );
    await settle();
    const line = screen.getByText('Using example.com');
    expect(
      line.compareDocumentPosition(composer()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
