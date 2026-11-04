import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionState } from '../shared/session-state';

// Where the text of each session's messages is kept, which a search by conversation reads (ADR-0014).
export interface TextStorage {
  // The sessions that have a text.
  ids(): Promise<string[]>;
  read(id: string): Promise<string | undefined>;
  write(id: string, text: string): Promise<void>;
  remove(id: string): Promise<void>;
}

// A session's id as a file's name: the app's ids are UUIDs, and anything else is refused.
const SAFE_ID = /^[A-Za-z0-9-]{1,100}$/;
const EXTENSION = '.txt';

// One file per session, <id>.txt, in the folder, a folder of the app's data, both readable by the user
// alone. A text is written whole to a file of its own first, so that a read never sees half of it.
export function textStorage(folder: string): TextStorage {
  const fileOf = (id: string) => {
    if (!SAFE_ID.test(id)) throw new Error('A session’s text is kept only under the app’s own id.');
    return join(folder, id + EXTENSION);
  };
  const made = mkdir(folder, { recursive: true, mode: 0o700 }).then(() => chmod(folder, 0o700));
  return {
    async ids() {
      await made;
      const names = await readdir(folder);
      return names
        .filter((name) => name.endsWith(EXTENSION))
        .map((name) => name.slice(0, -EXTENSION.length))
        .filter((id) => SAFE_ID.test(id));
    },
    async read(id) {
      try {
        return await readFile(fileOf(id), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async write(id, text) {
      await made;
      const file = fileOf(id);
      const written = `${file}.${String(process.pid)}.writing`;
      await writeFile(written, text, { encoding: 'utf8', mode: 0o600 });
      await rename(written, file);
    },
    async remove(id) {
      await rm(fileOf(id), { force: true });
    },
  };
}

// A storage that keeps the texts in memory, for a host that keeps none on disk, such as in tests.
export function memoryTextStorage(texts = new Map<string, string>()): TextStorage {
  return {
    ids: () => Promise.resolve([...texts.keys()]),
    read: (id) => Promise.resolve(texts.get(id)),
    write: (id, text) => {
      texts.set(id, text);
      return Promise.resolve();
    },
    remove: (id) => {
      texts.delete(id);
      return Promise.resolve();
    },
  };
}

// The text a search by conversation reads of a session: the user's and the agent's messages, in order,
// without the agent's thinking.
export function textOf(state: SessionState): string {
  return state.timeline
    .flatMap((item) =>
      item.type === 'message' && item.role !== 'thinking' && item.text !== '' ? [item.text] : [],
    )
    .join('\n\n');
}

// How many characters of the conversation a passage shows before the word it found, and after it.
const BEFORE = 40;
const AFTER = 80;

// Whether a session's title and conversation together hold every word, whatever its case, and if so
// the passage of the conversation where the first word it holds appears; null for no match.
export function matchOf(
  words: readonly string[],
  title: string,
  text: string,
): { snippet?: string } | null {
  if (words.length === 0) return null;
  const inTitle = title.toLowerCase();
  const inText = text.toLowerCase();
  if (!words.every((word) => inTitle.includes(word) || inText.includes(word))) return null;
  const word = words.find((each) => inText.includes(each));
  if (word === undefined) return {};
  // Lower case can change a text's length, in which case the passage is the lower-cased text's.
  const source = inText.length === text.length ? text : inText;
  const at = inText.indexOf(word);
  const start = Math.max(0, at - BEFORE);
  const end = Math.min(source.length, at + word.length + AFTER);
  const passage = source.slice(start, end).replace(/\s+/g, ' ').trim();
  return { snippet: `${start > 0 ? '…' : ''}${passage}${end < source.length ? '…' : ''}` };
}
