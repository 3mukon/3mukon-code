import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dayFolder, isDayFolder, makeDayFolder } from './folders';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'session-folders-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('day folders', () => {
  it('names a folder for each day in the 3mukon-code folder of the home folder', () => {
    expect(dayFolder('/Users/me', new Date(2026, 9, 28, 23, 59))).toBe(
      '/Users/me/3mukon-code/2026-10-28',
    );
    expect(dayFolder('/Users/me', new Date(2027, 0, 3))).toBe('/Users/me/3mukon-code/2027-01-03');
  });

  it('knows a day’s folder from any other', () => {
    expect(isDayFolder('/Users/me', '/Users/me/3mukon-code/2026-10-28')).toBe(true);
    for (const path of [
      '/Users/me/3mukon-code',
      '/Users/me/3mukon-code/2026-10-28/src',
      '/Users/me/3mukon-code/../2026-10-28',
      '/Users/me/3mukon-code/notes',
      '/Users/other/3mukon-code/2026-10-28',
    ]) {
      expect(isDayFolder('/Users/me', path)).toBe(false);
    }
  });

  it('makes a day’s folder when its first session starts, and no other', async () => {
    const day = dayFolder(home, new Date(2026, 9, 28));
    await makeDayFolder(home, day);
    expect(existsSync(day)).toBe(true);
    await makeDayFolder(home, day);
    await makeDayFolder(home, join(home, 'elsewhere'));
    expect(existsSync(join(home, 'elsewhere'))).toBe(false);
  });
});
