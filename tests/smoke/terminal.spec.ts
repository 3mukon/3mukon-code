import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { answerQuestion, dataFolder, launch, pickFolder } from './app';

// Types a command into the terminal and runs it.
async function run(window: Page, terminal: Locator, command: string) {
  await terminal.locator('.xterm').click();
  await window.keyboard.type(command);
  await window.keyboard.press('Enter');
}

// What a new terminal's first frames showed: its shell's output drawn while the terminal was still
// clear, the terminal shown while still empty, as just before its first prompt, or neither within
// ten seconds.
type FirstShow = 'drawn first' | 'shown empty' | 'none';

// The page's globals that the watch below uses, which the tests' types, without the DOM's, leave out.
interface PageGlobals {
  document: { querySelector(selector: string): PageElement | null };
  getComputedStyle(element: PageElement): { opacity: string };
  requestAnimationFrame(callback: () => void): number;
}
interface PageElement {
  querySelector(selector: string): { textContent: string | null } | null;
}

// Watches the next terminal to open, frame by frame, until its shell has drawn something in it.
function watchFirstShow(window: Page): Promise<FirstShow> {
  return window.evaluate(
    () =>
      new Promise<FirstShow>((resolve) => {
        const page = globalThis as unknown as PageGlobals;
        const until = Date.now() + 10_000;
        const frame = () => {
          const emulator = page.document.querySelector('.terminal-paper > div');
          if (emulator !== null) {
            const rows = emulator.querySelector('.xterm-rows')?.textContent ?? '';
            if (rows.trim() !== '') {
              resolve('drawn first');
              return;
            }
            if (Number(page.getComputedStyle(emulator).opacity) > 0) {
              resolve('shown empty');
              return;
            }
          }
          if (Date.now() > until) resolve('none');
          else page.requestAnimationFrame(frame);
        };
        page.requestAnimationFrame(frame);
      }),
  );
}

test('a workspace’s menu opens a terminal in its folder, ⌃` another beside it, and closing one asks before ending its program', async () => {
  const data = dataFolder();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-terminal-')));
  try {
    const app = await launch(data.path, '--lang=en-US');
    try {
      const window = await app.firstWindow();
      await pickFolder(app, folder);
      await window.getByRole('button', { name: 'Add workspace' }).click();
      await answerQuestion(window, 'Trust');
      await window.getByRole('treeitem', { selected: true }).click({ button: 'right' });
      const firstShow = watchFirstShow(window);
      await window.getByRole('menu').getByRole('menuitem', { name: 'Open in Terminal' }).click();
      const main = window.getByRole('main');
      const terminal = main.getByRole('region', { name: 'Terminal' });
      await expect(terminal).toHaveCount(1);
      // The terminal stays clear until its shell has drawn its prompt, which then shows whole.
      expect(await firstShow).toBe('drawn first');
      // The login shell runs in the workspace's folder, as the app's terminal, at its panel's size.
      await run(window, terminal, 'echo "$TERM_PROGRAM in $PWD:"; echo "size:$(stty size):"');
      const rows = terminal.locator('.xterm-rows');
      await expect(rows).toContainText(`3mukon-code in ${folder}:`);
      // The terminal's program has as many rows as the emulator draws.
      const drawn = await rows.locator('> div').count();
      await expect(rows).toContainText(new RegExp(`size:${String(drawn)} \\d+:`));
      // ⌃` opens another terminal beside the focused one, in its folder.
      await window.keyboard.press('Control+Backquote');
      await expect(main.getByRole('region', { name: 'Terminal' })).toHaveCount(2);
      const second = main.getByRole('region', { name: 'Terminal' }).nth(1);
      await run(window, second, 'pwd');
      await expect(second.locator('.xterm-rows')).toContainText(folder);
      // A program other than the shell runs, so closing its panel asks first, and Cancel keeps it.
      await run(window, second, 'sleep 30');
      await expect
        .poll(async () => second.locator('.xterm-rows').textContent())
        .toContain('sleep 30');
      await second.getByRole('button', { name: 'Close panel' }).click();
      await expect(window.getByRole('alertdialog')).toContainText('End sleep');
      await answerQuestion(window, 'Cancel');
      await expect(main.getByRole('region', { name: 'Terminal' })).toHaveCount(2);
      await second.getByRole('button', { name: 'Close panel' }).click();
      await answerQuestion(window, 'Close');
      await expect(main.getByRole('region', { name: 'Terminal' })).toHaveCount(1);
      // With the shell alone, the panel closes at once.
      await terminal.getByRole('button', { name: 'Close panel' }).click();
      await expect(main.getByRole('region', { name: 'Terminal' })).toHaveCount(0);
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a folder’s menu in a workspace’s tree opens a terminal in that folder', async () => {
  const data = dataFolder();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-terminal-')));
  mkdirSync(join(folder, 'docs'));
  try {
    const app = await launch(data.path, '--lang=en-US');
    try {
      const window = await app.firstWindow();
      await pickFolder(app, folder);
      await window.getByRole('button', { name: 'Add workspace' }).click();
      await answerQuestion(window, 'Trust');
      await window.getByRole('treeitem', { selected: true }).click();
      await window.getByRole('treeitem', { name: 'docs' }).click({ button: 'right' });
      // The folder's own menu, which holds Open in Terminal alone.
      const menu = window.getByRole('menu');
      await expect(menu.getByRole('menuitem')).toHaveText(['Open in Terminal']);
      await menu.getByRole('menuitem', { name: 'Open in Terminal' }).click();
      const terminal = window.getByRole('main').getByRole('region', { name: 'Terminal' });
      await run(window, terminal, 'echo "in $PWD:"');
      await expect(terminal.locator('.xterm-rows')).toContainText(`in ${join(folder, 'docs')}:`);
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(folder, { recursive: true, force: true });
  }
});

// A program that asks the terminal for its foreground and background, as Codex does as it starts, and
// prints the answers with their escapes spelled out.
const ASK_COLOURS = [
  "process.stdin.setEncoding('utf8');",
  'process.stdin.setRawMode(true);',
  "let answer = '';",
  "process.stdin.on('data', (chunk) => { answer += chunk; });",
  "process.stdout.write('\\x1b]10;?\\x1b\\\\\\x1b]11;?\\x1b\\\\');",
  'setTimeout(() => {',
  '  process.stdin.setRawMode(false);',
  "  console.log('ANSWER ' + answer.replaceAll('\\x1b', 'ESC'));",
  '  process.exit(0);',
  '}, 500);',
].join('\n');

// The page's globals that the reads below use, which the tests' types, without the DOM's, leave out.
interface StyledPage {
  document: { documentElement: unknown };
  getComputedStyle(element: unknown): { getPropertyValue(name: string): string };
  matchMedia(query: string): { matches: boolean };
}

// The window's ink and paper, as its tokens give them in the appearance it shows.
function inkAndPaper(window: Page): Promise<{ ink: string; paper: string }> {
  return window.evaluate(() => {
    const page = globalThis as unknown as StyledPage;
    const style = page.getComputedStyle(page.document.documentElement);
    return {
      ink: style.getPropertyValue('--ink').trim(),
      paper: style.getPropertyValue('--frame').trim(),
    };
  });
}

// A colour given as #rrggbb, as a terminal reports it and as a page computes it.
const reported = (hex: string) =>
  `rgb:${[1, 3, 5].map((at) => hex.slice(at, at + 2).repeat(2)).join('/')}`;
const computed = (hex: string) =>
  `rgb(${[1, 3, 5].map((at) => String(parseInt(hex.slice(at, at + 2), 16))).join(', ')})`;

test('a terminal tells a program that asks for its colours the window’s ink and paper, in either appearance', async () => {
  const data = dataFolder();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-terminal-')));
  writeFileSync(join(folder, 'ask.cjs'), ASK_COLOURS);
  try {
    const app = await launch(data.path, '--lang=en-US');
    try {
      const window = await app.firstWindow();
      await pickFolder(app, folder);
      await window.getByRole('button', { name: 'Add workspace' }).click();
      await answerQuestion(window, 'Trust');
      await window.getByRole('treeitem', { selected: true }).click({ button: 'right' });
      await window.getByRole('menu').getByRole('menuitem', { name: 'Open in Terminal' }).click();
      const terminal = window.getByRole('main').getByRole('region', { name: 'Terminal' });
      const rows = terminal.locator('.xterm-rows');
      for (const appearance of ['light', 'dark'] as const) {
        // The page in the appearance, as macOS would show it, which Playwright otherwise holds at
        // light.
        await window.emulateMedia({ colorScheme: appearance });
        await expect
          .poll(() =>
            window.evaluate(
              () =>
                (globalThis as unknown as StyledPage).matchMedia('(prefers-color-scheme: dark)')
                  .matches,
            ),
          )
          .toBe(appearance === 'dark');
        const { ink, paper } = await inkAndPaper(window);
        // The terminal has taken the appearance's colours, and answers with them: the paper, which
        // it draws clear so that the paper's grain shows, rather than black.
        await expect(rows).toHaveCSS('color', computed(ink));
        await run(window, terminal, `'${process.execPath}' ask.cjs`);
        await expect(rows).toContainText(
          `ANSWER ESC]10;${reported(ink)}ESC\\ESC]11;${reported(paper)}ESC\\`,
        );
      }
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(folder, { recursive: true, force: true });
  }
});
