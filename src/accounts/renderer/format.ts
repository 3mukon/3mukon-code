import type { TFunction } from 'i18next';
import type { UsageWindow } from '../shared/accounts';

// A window's name: by its span, such as 5-hour limit or Weekly limit, with the models it holds alone.
export function windowName(t: TFunction, window: UsageWindow): string {
  const { span } = window;
  const name =
    span === null
      ? t('accounts.window.other')
      : typeof span === 'number'
        ? t('accounts.window.hours', { count: Math.max(1, Math.round(span / 60)) })
        : t(`accounts.window.${span}`);
  return window.model === undefined
    ? name
    : t('accounts.window.model', { window: name, model: window.model });
}

// A share in percent, such as 62%, in the window's language.
export function share(percent: number, language: string): string {
  return new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(
    percent / 100,
  );
}

const DAY_MS = 24 * 60 * 60_000;

// When a window resets, in local time and the window's language: the time alone today, the weekday
// and time within the week, and the date and time beyond.
export function resetTime(at: number, now: number, language: string): string {
  const date = new Date(at);
  const today = new Date(now);
  const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  const sameDay = date.toDateString() === today.toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? time
    : at - now < 6 * DAY_MS
      ? { weekday: 'short', ...time }
      : { month: 'short', day: 'numeric', ...time };
  return new Intl.DateTimeFormat(language, options).format(date);
}

// How long ago something was read, such as 3 minutes ago, in the window's language; null within the
// last minute.
export function readWhen(at: number, now: number, language: string): string | null {
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const minutes = Math.round((at - now) / 60_000);
  if (minutes === 0) return null;
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, 'hour');
  return format.format(Math.round(hours / 24), 'day');
}
