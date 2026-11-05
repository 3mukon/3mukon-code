import { _electron as electron, expect, test } from '@playwright/test';
import { dataFolder, isolatedEnvironment } from './app';

// Launches the built app on the data folder in English in the isolated environment, its page
// following macOS's appearance as the app sets it, which Playwright otherwise holds at light.
const launch = (data: string) =>
  electron.launch({
    args: ['.', `--user-data-dir=${data}`, '--lang=en-US'],
    env: isolatedEnvironment(data),
    colorScheme: null,
  });

// Whether the window's page takes the dark appearance.
const dark = () =>
  (globalThis as unknown as { matchMedia: (query: string) => { matches: boolean } }).matchMedia(
    '(prefers-color-scheme: dark)',
  ).matches;

test('the settings open in a panel of their own, and their language and appearance apply at once and after a restart', async () => {
  const data = dataFolder();
  try {
    const app = await launch(data.path);
    try {
      const window = await app.firstWindow();
      await window.getByRole('heading', { name: 'Sessions' }).waitFor();
      await window.keyboard.press('Meta+Comma');
      const main = window.getByRole('main');
      const settings = main.getByRole('region', { name: 'Settings' });
      await expect(settings).toHaveAttribute('aria-current', 'true');
      // The appearance applies at once, to the window's page and to macOS's own panels.
      const appearance = settings.getByRole('radiogroup', { name: 'Appearance' });
      await appearance.getByRole('radio', { name: 'Dark' }).click();
      await expect
        .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
        .toBe('dark');
      await expect.poll(() => window.evaluate(dark)).toBe(true);
      // So does the language, the window's and the main process's.
      const language = settings.getByRole('radiogroup', { name: 'Language' });
      await language.getByRole('radio', { name: '简体中文' }).click();
      await expect(window.getByRole('heading', { name: '会话' })).toBeVisible();
      await expect(window.locator('html')).toHaveAttribute('lang', 'zh-Hans');
      // The gear just after the archived sessions' button shows the same panel, which stays one.
      await window.getByRole('button', { name: '设置' }).click();
      await expect(main.getByRole('region', { name: '设置' })).toHaveCount(1);
    } finally {
      await app.close();
    }
    // A restart starts in them.
    const again = await launch(data.path);
    try {
      const window = await again.firstWindow();
      await expect(window.getByRole('heading', { name: '会话' })).toBeVisible();
      expect(await again.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
      await expect.poll(() => window.evaluate(dark)).toBe(true);
    } finally {
      await again.close();
    }
  } finally {
    data.remove();
  }
});
