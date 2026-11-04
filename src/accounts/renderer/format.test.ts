import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import en from '../../i18n/catalogs/en.json';
import { readWhen, resetTime, share, windowName } from './format';

beforeAll(async () => {
  await i18next.init({ lng: 'en', resources: { en: { translation: en } } });
});

describe('the accounts’ formats', () => {
  it('names a window by its span and the models it holds alone', () => {
    const t = i18next.t.bind(i18next);
    expect(windowName(t, { span: 'five-hour', used: 1, resetsAt: null })).toBe('5-hour limit');
    expect(windowName(t, { span: 'week', model: 'Opus', used: 1, resetsAt: null })).toBe(
      'Weekly limit · Opus',
    );
    expect(windowName(t, { span: 720, used: 1, resetsAt: null })).toBe('12-hour limit');
    expect(windowName(t, { span: null, used: null, resetsAt: null })).toBe('Usage limit');
  });

  it('says a share and when a window resets in the window’s language, and how long ago a read was', () => {
    expect(share(84.4, 'en')).toBe('84%');
    expect(share(84.4, 'zh-Hans')).toBe('84%');
    const now = new Date(2026, 10, 4, 9, 0).getTime();
    expect(resetTime(new Date(2026, 10, 4, 14, 30).getTime(), now, 'en')).toBe('2:30 PM');
    expect(resetTime(new Date(2026, 10, 6, 9, 5).getTime(), now, 'en')).toBe('Fri 9:05 AM');
    expect(resetTime(new Date(2026, 10, 20, 9, 5).getTime(), now, 'en')).toBe('Nov 20, 9:05 AM');
    expect(readWhen(now - 3 * 60_000, now, 'en')).toBe('3 minutes ago');
    expect(readWhen(now - 20_000, now, 'en')).toBeNull();
    expect(readWhen(now - 5 * 3_600_000, now, 'en')).toBe('5 hours ago');
    expect(readWhen(now - 3 * 3_600_000, now, 'zh-Hans')).toBe('3小时前');
  });
});
