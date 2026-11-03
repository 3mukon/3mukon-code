import { useEffect, useState } from 'react';
import { Menu } from '../../ui/renderer/menu';
import { QuestionDialog } from '../../ui/renderer/question';
import type { Prompt } from '../../ui/shared/prompts';
import type { PromptsBridge } from '../shared/bridge';

interface Point {
  x: number;
  y: number;
}

interface Shown {
  id: number;
  prompt: Prompt;
  // Where a menu opens.
  at: Point;
}

// How recently a menu must have been asked for at a place, by the pointer or the keyboard, for the
// main process's menu to open there.
const ASKED_WITHIN_MS = 1_000;

// Draws the menus and questions the main process asks the user, one at a time and in the order asked,
// with the ui module's menu and question, and sends each answer back: a menu opens where the pointer
// or the keyboard last asked for one, as a secondary click, the menu key or VoiceOver's menu command
// does, and otherwise at the element with the focus; a question opens over the window.
export function PromptHost({ bridge }: { bridge: PromptsBridge }) {
  const [queue, setQueue] = useState<Shown[]>([]);

  useEffect(() => {
    let asked: { at: Point; time: number } | undefined;
    const onContextMenu = (event: MouseEvent) => {
      asked = { at: pointOf(event), time: Date.now() };
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const menuKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
      if (menuKey) asked = { at: focusedPoint(), time: Date.now() };
    };
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('keydown', onKeyDown, true);
    const stop = bridge.onPrompt((id, prompt) => {
      const at =
        asked !== undefined && Date.now() - asked.time < ASKED_WITHIN_MS
          ? asked.at
          : focusedPoint();
      setQueue((shown) => [...shown, { id, prompt, at }]);
    });
    return () => {
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('keydown', onKeyDown, true);
      stop();
    };
  }, [bridge]);

  const shown = queue[0];
  if (shown === undefined) return null;
  const answer = (given: string | null) => {
    setQueue((waiting) => waiting.filter((prompt) => prompt.id !== shown.id));
    bridge.answer(shown.id, given).catch((error: unknown) => {
      console.error('The answer could not reach the main process:', error);
    });
  };
  return shown.prompt.kind === 'menu' ? (
    <Menu key={shown.id} entries={shown.prompt.entries} at={shown.at} onClose={answer} />
  ) : (
    <QuestionDialog key={shown.id} question={shown.prompt.question} onAnswer={answer} />
  );
}

// Where a menu asked for by the event opens: at the pointer, or, where the keyboard or VoiceOver asked
// for it and the event's place lies outside its element, under the element's start.
function pointOf(event: MouseEvent): Point {
  const point = { x: event.clientX, y: event.clientY };
  if (!(event.target instanceof Element)) return point;
  const box = event.target.getBoundingClientRect();
  const inside =
    point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
  return inside && (point.x !== 0 || point.y !== 0) ? point : { x: box.left, y: box.bottom };
}

// Under the start of the element with the focus, or else the middle of the window.
function focusedPoint(): Point {
  const focused = document.activeElement;
  if (focused === null || focused === document.body) {
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }
  const box = focused.getBoundingClientRect();
  return { x: box.left, y: box.bottom };
}
