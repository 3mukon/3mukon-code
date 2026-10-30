import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDayFolder } from '../shared/folders';

// The folder that holds the day folders: 3mukon-code in the user's home folder.
export function dayRoot(home: string): string {
  return join(home, '3mukon-code');
}

// Where a session page opens while no workspace has been added: the folder of the day's date, as
// YYYY-MM-DD in the Mac's time zone, in the day root.
export function dayFolder(home: string, now: Date): string {
  const day = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return join(dayRoot(home), day);
}

// Makes a day's folder when its first session starts there, so that a page opened and closed
// without a message leaves nothing behind; other folders are left as they are.
export async function makeDayFolder(home: string, path: string): Promise<void> {
  if (isDayFolder(dayRoot(home), path)) await mkdir(path, { recursive: true });
}
