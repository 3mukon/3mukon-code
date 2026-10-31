import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { ModelOption, SessionEvent } from '../shared/events';
import { initialSessionState, type SessionState } from '../shared/session-state';
import type { SessionEventsListener, SessionsBridge } from '../shared/sessions';
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
    list: () => Promise.resolve([]),
    onChange: () => () => undefined,
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
          openedAt: 0,
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
    render(
      <SessionPage bridge={bridge} folder="/Users/me/web" sessionId={null} onStarted={onStarted} />,
    );
    await settle();
    // A gateway appears for a provider that has gateways, and effort for a model that takes it.
    choose('Gateway', 'work');
    await settle();
    expect(bridge.models.mock.calls.at(-1)).toEqual(['claude-code', 'work']);
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

  it('takes a model’s own default effort where it has no medium, and Default where it names none', async () => {
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
      ['', 'Default effort'],
      ['low', 'Low'],
      ['max', 'Max'],
    ]);
    expect(chooser('Reasoning effort').value).toBe('');
    choose('Model', 'mono');
    expect(screen.queryByRole('combobox', { name: 'Reasoning effort' })).toBeNull();
  });

  it('says it is loading the models until they come, and has those found ahead of time at once', async () => {
    const { bridge } = fakeBridge();
    let answer: (models: ModelOption[]) => void = () => undefined;
    bridge.models.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    bridge.models.mockResolvedValue(MODELS);
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
      ['claude-code', null],
      ['codex', null],
    ]);
    render(page(ahead));
    expect(options('Model')[0]).toEqual(['', 'Sol']);
    expect(chooser('Reasoning effort').value).toBe('medium');
    expect(options('Gateway')).toEqual([
      ['', 'No gateway'],
      ['work', 'work'],
    ]);
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
          openedAt: 0,
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
          openedAt: 0,
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
    expect(screen.getByText('30,000 / 200,000 (15.0%)').title).toBe(
      '30,000 of 200,000 tokens of the context window in use (15.0%)',
    );
    // The turn ends; the next message goes to the session.
    emit(3, { type: 'message', id: 'm2', role: 'agent', text: 'Done: **all green**.' });
    emit(4, { type: 'turn-ended', outcome: 'completed' });
    expect(screen.getByText('all green').tagName).toBe('STRONG');
    expect(screen.queryByText('Working')).toBeNull();
    fireEvent.change(composer(), { target: { value: 'Thanks' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(bridge.send.mock.calls.at(-1)).toEqual(['s1', 'Thanks', []]);
  });
});
