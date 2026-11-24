import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { mainTranslator } from '../../i18n/main/i18n';
import type { Prompts } from '../../ui/shared/prompts';
import type { Workspace } from '../shared/workspaces';
import { windowWorkspacesUi } from './native';

const t = mainTranslator(['en-US']);
const window = {} as BrowserWindow;
const workspace: Workspace = { id: 'w1', name: 'web', path: '/Users/me/web', trusted: true };

describe('windowWorkspacesUi', () => {
  it('asks whether the user trusts a folder, Trust being the default answer and Don’t Trust Escape’s', async () => {
    const ask = vi.fn<Prompts['ask']>(() => Promise.resolve('trust'));
    const ui = windowWorkspacesUi(window, { menu: vi.fn(), ask }, t);
    expect(await ui.askTrust('web', '/Users/me/web')).toBe(true);
    expect(ask.mock.calls[0]?.[0]).toMatchObject({
      message: 'Do you trust the files in “web”?',
      detail:
        '/Users/me/web\n\n3mukon-code keeps your answer with the workspace, and you can change it later from the workspace’s menu. Claude Code, Codex CLI and Grok Build still apply their own trust rules.',
      answers: [
        { id: 'trust', label: 'Trust' },
        { id: 'distrust', label: 'Don’t Trust' },
      ],
      defaultId: 'trust',
      cancelId: 'distrust',
    });
    ask.mockResolvedValue('distrust');
    expect(await ui.askTrust('web', '/Users/me/web')).toBe(false);
  });

  it('names the providers in Simplified Chinese as the app does everywhere else', async () => {
    const ask = vi.fn<Prompts['ask']>(() => Promise.resolve('trust'));
    const ui = windowWorkspacesUi(window, { menu: vi.fn(), ask }, mainTranslator(['zh-Hans-CN']));
    await ui.askTrust('web', '/Users/me/web');
    expect(ask.mock.calls[0]?.[0]).toMatchObject({
      detail:
        '/Users/me/web\n\n3mukon-code 会把你的回答与这个工作区一起保存，你之后可以在工作区的菜单中更改。Claude Code、Codex CLI 和 Grok Build 仍按各自的信任规则处理。',
    });
  });

  it('offers Open in Terminal, Trusted, checked while it is, and Remove Workspace in a workspace’s menu, and does what is chosen', async () => {
    for (const [chosen, called] of [
      ['open-in-terminal', null],
      ['trusted', 'setTrusted'],
      ['remove', 'remove'],
      [null, null],
    ] as const) {
      const menu = vi.fn<Prompts['menu']>(() => Promise.resolve(chosen));
      const actions = { setTrusted: vi.fn(), remove: vi.fn() };
      const answer = await windowWorkspacesUi(window, { menu, ask: vi.fn() }, t).showMenu(
        workspace,
        actions,
      );
      expect(menu.mock.calls[0]?.[0]).toEqual([
        { id: 'open-in-terminal', label: 'Open in Terminal' },
        { separator: true },
        { id: 'trusted', label: 'Trusted', checked: true },
        { separator: true },
        { id: 'remove', label: 'Remove Workspace' },
      ]);
      // Opening a terminal is the window's to do.
      expect(answer).toBe(chosen === 'open-in-terminal' ? 'open-in-terminal' : null);
      expect(actions.setTrusted.mock.calls).toEqual(called === 'setTrusted' ? [[false]] : []);
      expect(actions.remove).toHaveBeenCalledTimes(called === 'remove' ? 1 : 0);
    }
  });

  it('offers Open in Terminal in the menu of a folder inside a workspace', async () => {
    for (const chosen of ['open-in-terminal', null] as const) {
      const menu = vi.fn<Prompts['menu']>(() => Promise.resolve(chosen));
      const answer = await windowWorkspacesUi(window, { menu, ask: vi.fn() }, t).showFolderMenu();
      expect(menu.mock.calls[0]?.[0]).toEqual([
        { id: 'open-in-terminal', label: 'Open in Terminal' },
      ]);
      expect(answer).toBe(chosen);
    }
  });
});
