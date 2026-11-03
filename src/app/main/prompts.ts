import type { BrowserWindow, WebContents } from 'electron';
import { itemIds, type Prompt, type Prompts } from '../../ui/shared/prompts';
import { channels } from '../shared/bridge';

interface Waiting {
  // The page the prompt was sent to, which alone answers it.
  contents: WebContents;
  // The answers the prompt takes.
  answers: ReadonlySet<string | null>;
  // Its answer when the page goes before giving one.
  cancelled: string | null;
  resolve: (answer: string | null) => void;
}

// The prompts sent to pages and not yet answered, by id.
const waiting = new Map<number, Waiting>();
let lastId = 0;
// The pages whose going cancels their prompts.
const watched = new WeakSet<WebContents>();

// What the main process asks the user in the window, drawn by its page in the app's own look: each
// prompt goes to the page with an id of its own, and the answer the page sends back with that id
// resolves it. While the window is gone, or once its page goes or loads anew, a menu resolves with
// null and a question with its cancel answer.
export function windowPrompts(window: BrowserWindow): Prompts {
  const show = (prompt: Prompt, answers: (string | null)[], cancelled: string | null) =>
    new Promise<string | null>((resolve) => {
      if (window.isDestroyed()) {
        resolve(cancelled);
        return;
      }
      const contents = window.webContents;
      lastId += 1;
      waiting.set(lastId, { contents, answers: new Set(answers), cancelled, resolve });
      cancelWhenGone(contents);
      contents.send(channels.prompts.show, { id: lastId, prompt });
    });
  return {
    menu: (entries) => show({ kind: 'menu', entries }, [null, ...itemIds(entries)], null),
    ask: async (question) =>
      (await show(
        { kind: 'question', question },
        question.answers.map((answer) => answer.id),
        question.cancelId,
      )) ?? question.cancelId,
  };
}

// Takes a page's answer to a prompt sent to it. An answer from another page, to a prompt that is not
// waiting, or that the prompt does not take, changes nothing.
export function answerPrompt(contents: WebContents, id: number, answer: string | null): void {
  const prompt = waiting.get(id);
  if (prompt?.contents !== contents || !prompt.answers.has(answer)) return;
  waiting.delete(id);
  prompt.resolve(answer);
}

function cancelWhenGone(contents: WebContents): void {
  if (watched.has(contents)) return;
  watched.add(contents);
  const cancel = () => {
    for (const [id, prompt] of waiting) {
      if (prompt.contents !== contents) continue;
      waiting.delete(id);
      prompt.resolve(prompt.cancelled);
    }
  };
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) cancel();
  });
  contents.on('render-process-gone', cancel);
  contents.once('destroyed', cancel);
}
