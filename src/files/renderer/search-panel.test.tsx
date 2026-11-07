import { getSearchQuery, openSearchPanel } from '@codemirror/search';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { editorSetup } from './editor-setup';

// The editor's words as the English catalog gives them, so that the bar's controls go by their names.
const PHRASES = {
  Find: 'Find',
  Replace: 'Replace',
  'Toggle Replace': 'Toggle Replace',
  next: 'Next match',
  previous: 'Previous match',
  all: 'Select All',
  'match case': 'Match case',
  regexp: 'Regular expression',
  'by word': 'Whole word',
  replace: 'Replace',
  'replace all': 'Replace All',
  close: 'Close',
  'Replace with': 'Replace with',
  Invalid: 'Invalid',
  'No results': 'No results',
  '$ found': '$ found',
  '$1 of $2': '$1 of $2',
};

let views: EditorView[] = [];
afterEach(async () => {
  for (const view of views) view.destroy();
  views = [];
  // The bar's React root goes once the editor's update is over.
  await act(() => Promise.resolve());
  document.body.innerHTML = '';
});

// An editor of the text with its search bar open, and the bar's find field.
function open(text: string, { readOnly = false, selection = EditorSelection.cursor(0) } = {}) {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      selection,
      extensions: [editorSetup(PHRASES, 'notes.txt'), EditorState.readOnly.of(readOnly)],
    }),
  });
  views.push(view);
  act(() => {
    openSearchPanel(view);
  });
  return { view, parent, find: screen.getByRole('textbox', { name: 'Find' }) };
}

const type = (field: HTMLElement, value: string) => {
  fireEvent.change(field, { target: { value } });
};
const status = () => screen.queryByRole('status')?.textContent ?? null;
const selected = (view: EditorView) =>
  view.state.selection.ranges.map((range) => view.state.sliceDoc(range.from, range.to));
const toggleReplace = () => screen.getByRole('button', { name: 'Toggle Replace' });
const replacement = () => screen.queryByRole('textbox', { name: 'Replace with' });

describe('the editor’s search bar', () => {
  it('opens over the top of the editor with the focus in its field and the replacement folded, counts the matches and the one selected, and finds them with Return and Shift-Return', () => {
    const { view, parent, find } = open('one two one three one');
    expect(parent.querySelector('.cm-panels-top .cm-search')).not.toBeNull();
    expect(document.activeElement).toBe(find);
    expect(toggleReplace().getAttribute('aria-expanded')).toBe('false');
    expect(replacement()).toBeNull();
    expect(status()).toBeNull();

    type(find, 'one');
    expect(getSearchQuery(view.state).search).toBe('one');
    expect(status()).toBe('3 found');
    fireEvent.keyDown(find, { key: 'Enter' });
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 3 });
    expect(status()).toBe('1 of 3');
    fireEvent.keyDown(find, { key: 'Enter', shiftKey: true });
    expect(view.state.selection.main).toMatchObject({ from: 18, to: 21 });
    expect(status()).toBe('3 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(status()).toBe('1 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(status()).toBe('3 of 3');

    type(find, 'four');
    expect(status()).toBe('No results');
  });

  it('turns on matching by case, by whole word and as a regular expression, and says when an expression does not parse', () => {
    const { view, find } = open('One one oneness');
    type(find, 'one');
    expect(status()).toBe('3 found');
    const toggle = (name: string) => screen.getByRole('button', { name });
    fireEvent.click(toggle('Match case'));
    expect(toggle('Match case').getAttribute('aria-pressed')).toBe('true');
    expect(getSearchQuery(view.state).caseSensitive).toBe(true);
    expect(status()).toBe('2 found');
    fireEvent.click(toggle('Whole word'));
    expect(status()).toBe('1 found');
    fireEvent.click(toggle('Match case'));
    fireEvent.click(toggle('Whole word'));
    expect(toggle('Whole word').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle('Regular expression'));
    type(find, 'on(e');
    expect(status()).toBe('Invalid');
    expect(find.getAttribute('aria-invalid')).toBe('true');
    type(find, 'on(e|eness)');
    expect(status()).toBe('3 found');
    expect(find.getAttribute('aria-invalid')).toBe('false');
  });

  it('unfolds the replacement, replaces the match selected and then every match, selects all of them, and closes with Escape', async () => {
    const { view, find } = open('one two one three one');
    type(find, 'one');
    fireEvent.click(toggleReplace());
    expect(toggleReplace().getAttribute('aria-expanded')).toBe('true');
    const field = replacement();
    if (field === null) throw new Error('The replacement is not unfolded.');
    expect(document.activeElement).toBe(field);
    type(field, '1');
    expect(getSearchQuery(view.state).replace).toBe('1');
    // The first Replace selects the next match, and the next replaces it.
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(view.state.doc.toString()).toBe('1 two one three one');
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    expect(selected(view)).toEqual(['one', 'one']);
    fireEvent.click(screen.getByRole('button', { name: 'Replace All' }));
    expect(view.state.doc.toString()).toBe('1 two 1 three 1');

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find' }), { key: 'Escape' });
    await act(() => Promise.resolve());
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull();
  });

  it('folds the replacement away again with the focus back in the query, and opens folded each time', async () => {
    const { view, find } = open('one two');
    fireEvent.click(toggleReplace());
    expect(document.activeElement).toBe(replacement());
    fireEvent.click(toggleReplace());
    expect(toggleReplace().getAttribute('aria-expanded')).toBe('false');
    expect(replacement()).toBeNull();
    expect(document.activeElement).toBe(find);

    fireEvent.click(toggleReplace());
    fireEvent.keyDown(find, { key: 'Escape' });
    await act(() => Promise.resolve());
    act(() => {
      openSearchPanel(view);
    });
    expect(toggleReplace().getAttribute('aria-expanded')).toBe('false');
    expect(replacement()).toBeNull();
  });

  it('starts from the word selected as it opens, and leaves the replacement out of a file that cannot be edited', () => {
    const { find } = open('one two three', {
      readOnly: true,
      selection: EditorSelection.range(4, 7),
    });
    expect((find as HTMLInputElement).value).toBe('two');
    expect(status()).toBe('1 of 1');
    expect(screen.queryByRole('button', { name: 'Toggle Replace' })).toBeNull();
    expect(replacement()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace All' })).toBeNull();
  });
});
