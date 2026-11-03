// What the main process asks the user in a window, which the window's page draws in the app's own look
// instead of macOS's menus and sheets: a menu at the pointer, and a question with its answers. Plain
// data, so that it crosses the bridge.

// An item of a menu, by its id; one that is checked or not, such as a setting, shows a checkmark while
// it is.
export interface MenuItem {
  id: string;
  label: string;
  checked?: boolean;
}

// A menu's entries, in order; a separator is a line between groups of items.
export type MenuEntry = MenuItem | { separator: true };

// A question and its answers, the first of them the main one, which shows at the right, as macOS lays
// out a sheet's buttons. Return gives the default answer and Escape the cancel answer.
export interface Question {
  message: string;
  detail: string;
  answers: { id: string; label: string }[];
  defaultId: string;
  cancelId: string;
}

export type Prompt =
  { kind: 'menu'; entries: MenuEntry[] } | { kind: 'question'; question: Question };

// Shows menus and questions in a window's page. A menu resolves with the chosen item's id, or null
// when it closes without a choice; a question with the id of the answer given, or its cancel answer
// when the page goes first.
export interface Prompts {
  menu(entries: MenuEntry[]): Promise<string | null>;
  ask(question: Question): Promise<string>;
}

// The ids of the menu's items.
export function itemIds(entries: readonly MenuEntry[]): string[] {
  return entries.flatMap((entry) => ('separator' in entry ? [] : [entry.id]));
}
