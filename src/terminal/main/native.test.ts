import { describe, expect, it, vi } from 'vitest';
import type { Prompts } from '../../ui/shared/prompts';
import { terminalEnvironment, windowTerminalUi } from './native';

describe('terminalEnvironment', () => {
  it('passes the app’s environment on with the terminal’s type and colours, and a UTF-8 locale where it has none', () => {
    const env = terminalEnvironment(
      { PATH: '/usr/bin', HOME: '/Users/me', GONE: undefined },
      'zh-CN',
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: '3mukon-code',
      LANG: 'zh_CN.UTF-8',
    });
    expect(terminalEnvironment({}, 'en').LANG).toBe('en_US.UTF-8');
    expect(terminalEnvironment({ LANG: 'C' }, 'zh-CN').LANG).toBe('C');
  });
});

describe('windowTerminalUi', () => {
  it('asks before ending a program, Cancel by default', async () => {
    const ask = vi.fn<Prompts['ask']>(() => Promise.resolve('close'));
    const t = (key: string, values?: Record<string, unknown>) =>
      values === undefined ? key : `${key} ${JSON.stringify(values)}`;
    const ui = windowTerminalUi({ menu: vi.fn(), ask }, t as never);
    expect(await ui.confirmEnd('sleep')).toBe(true);
    expect(ask.mock.calls[0]?.[0]).toMatchObject({
      message: 'terminal.close.message {"program":"sleep"}',
      defaultId: 'cancel',
      cancelId: 'cancel',
    });
    ask.mockResolvedValue('cancel');
    expect(await ui.confirmEnd('sleep')).toBe(false);
  });
});
