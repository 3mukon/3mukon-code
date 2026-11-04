import { userInfo } from 'node:os';
import { spawn } from 'node-pty';
import type { Translate } from '../../i18n/main/i18n';
import type { Prompts } from '../../ui/shared/prompts';
import type { SpawnPty } from './terminals';

// A program in a pseudo-terminal from node-pty (ADR-0015), whose terminal type xterm.js emulates.
export const spawnPty: SpawnPty = (file, args, { cwd, columns, rows, env }) => {
  const pty = spawn(file, args, { name: 'xterm-256color', cwd, cols: columns, rows, env });
  return {
    get process() {
      return pty.process;
    },
    onData(listener) {
      pty.onData(listener);
    },
    onExit(listener) {
      pty.onExit(({ exitCode }) => {
        listener(exitCode);
      });
    },
    write(data) {
      pty.write(data);
    },
    resize(columns, rows) {
      pty.resize(columns, rows);
    },
    kill() {
      pty.kill();
    },
  };
};

// The user's login shell: the one macOS gives the app, or else the account's own.
export function loginShell(): string {
  return process.env.SHELL ?? userInfo().shell ?? '/bin/zsh';
}

// The environment a terminal's programs start with: the app's own, with the terminal's type, its
// colours and, where the app has none, a UTF-8 locale for the app's region, which an app opened from
// the Finder lacks.
export function terminalEnvironment(
  app: NodeJS.ProcessEnv,
  locale: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(app)) {
    if (value !== undefined) env[name] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = '3mukon-code';
  if (app.LANG === undefined) {
    const region = /^[a-z]{2}[-_][A-Z]{2}$/.test(locale) ? locale.replace('-', '_') : 'en_US';
    env.LANG = `${region}.UTF-8`;
  }
  return env;
}

// What the terminals ask the user, in the window that asked.
export interface TerminalUi {
  // Asks before a terminal closes while a program runs in it, which closing it ends; resolves with
  // whether the user confirmed.
  confirmEnd(program: string): Promise<boolean>;
}

export function windowTerminalUi(prompts: Prompts, t: Translate): TerminalUi {
  return {
    async confirmEnd(program) {
      const answer = await prompts.ask({
        message: t('terminal.close.message', { program }),
        detail: t('terminal.close.detail'),
        answers: [
          { id: 'close', label: t('terminal.close.close') },
          { id: 'cancel', label: t('terminal.close.cancel') },
        ],
        defaultId: 'cancel',
        cancelId: 'cancel',
      });
      return answer === 'close';
    },
  };
}
