import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Where a session page opens while no workspace has been added: a folder of the day's date, as
// YYYY-MM-DD in the Mac's time zone, in the 3mukon-code folder of the user's home folder.
export function dayFolder(home: string, now: Date): string {
  const day = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return join(home, '3mukon-code', day);
}

// Whether the path is a folder of a day, as dayFolder names one.
export function isDayFolder(home: string, path: string): boolean {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(path.slice(join(home, '3mukon-code', '/').length));
  return path.startsWith(join(home, '3mukon-code', '/')) && day !== null;
}

// Makes a day's folder when its first session starts there, so that a page opened and closed
// without a message leaves nothing behind; other folders are left as they are.
export async function makeDayFolder(home: string, path: string): Promise<void> {
  if (isDayFolder(home, path)) await mkdir(path, { recursive: true });
}
