import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  selectMatches,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorState } from '@codemirror/state';
import { runScopeHandlers, type EditorView, type Panel } from '@codemirror/view';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Regex,
  Replace,
  Search,
  WholeWord,
  X,
} from '../../ui/renderer/icons';

// How many matches the bar counts at most, so that a query that matches all through a long file still
// answers at once.
const COUNTED = 1000;

// The editor's search bar, which CodeMirror shows at the top of the editor in place of its own panel,
// over its search state and commands, in the app's look and in the editor's phrases: the query, how
// many matches there are and which of them is selected, the toggles for case, whole words and regular
// expressions, the previous and the next match, Select All, and, while the file can be edited, the
// replacement with Replace and Replace All.
export function searchPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'cm-search';
  const root = createRoot(dom);
  const draw = (state: EditorState) => {
    root.render(<SearchBar view={view} state={state} />);
  };
  // Drawn at once, so that the field is there for CodeMirror to focus as the bar opens.
  flushSync(() => {
    draw(view.state);
  });
  return {
    dom,
    top: true,
    mount() {
      const field = dom.querySelector<HTMLInputElement>('[main-field]');
      field?.focus();
      field?.select();
    },
    update(update) {
      const queried = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setSearchQuery)),
      );
      if (
        queried ||
        update.docChanged ||
        update.selectionSet ||
        update.startState.readOnly !== update.state.readOnly
      ) {
        draw(update.state);
      }
    },
    destroy() {
      // Once CodeMirror's update is over, since the editor may go as another React root renders.
      queueMicrotask(() => {
        root.unmount();
      });
    },
  };
}

interface Counted {
  total: number;
  // The match the main selection is, counted from 1, or null when it is none of them.
  current: number | null;
  // Whether there are more matches than were counted.
  more: boolean;
}

// The query's matches in the document, up to COUNTED of them.
function countOf(state: EditorState, query: SearchQuery): Counted {
  const { from, to } = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current: number | null = null;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total += 1;
    if (next.value.from === from && next.value.to === to) current = total;
    if (total === COUNTED) return { total, current, more: !cursor.next().done };
  }
  return { total, current, more: false };
}

type Change = Partial<
  Pick<SearchQuery, 'search' | 'replace' | 'caseSensitive' | 'wholeWord' | 'regexp'>
>;

function SearchBar({ view, state }: { view: EditorView; state: EditorState }) {
  const query = getSearchQuery(state);
  const phrase = (text: string, ...insert: unknown[]) => state.phrase(text, ...insert);
  // What the fields show: what is typed, which becomes the query as it is typed, or a query set from
  // outside the bar, such as the selection ⌘F starts from.
  const [shown, setShown] = useState(query);
  const [fields, setFields] = useState({ search: query.search, replace: query.replace });
  if (!query.eq(shown)) {
    setShown(query);
    setFields({ search: query.search, replace: query.replace });
  }
  const counted = useMemo(() => (query.valid ? countOf(state, query) : null), [state, query]);

  // Sets the query, as the editor has it at the moment, with the change.
  const change = (changed: Change) => {
    const current = getSearchQuery(view.state);
    const next = new SearchQuery({
      search: current.search,
      replace: current.replace,
      caseSensitive: current.caseSensitive,
      wholeWord: current.wholeWord,
      regexp: current.regexp,
      literal: current.literal,
      ...changed,
    });
    if (!next.eq(current)) view.dispatch({ effects: setSearchQuery.of(next) });
  };

  // The editor's search keys, such as Escape and ⌘G, work in the bar too; Return finds the next
  // match, or with Shift the previous one, and in the replacement replaces the next.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (runScopeHandlers(view, event.nativeEvent, 'search-panel')) {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.getAttribute('name') === 'search') {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(view);
    } else if (target.getAttribute('name') === 'replace') {
      event.preventDefault();
      replaceNext(view);
    }
  };

  const status = statusOf(query, counted, phrase);
  return (
    <div
      onKeyDown={onKeyDown}
      className="grid grid-cols-[minmax(0,26rem)_auto_minmax(0,1fr)_auto] items-center gap-x-1 gap-y-1.5 px-5 py-2 text-[12px] text-ink"
    >
      <Field invalid={query.search !== '' && !query.valid}>
        <Search className="size-3.5 shrink-0 text-faint" />
        <input
          name="search"
          main-field="true"
          aria-label={phrase('Find')}
          aria-invalid={query.search !== '' && !query.valid}
          placeholder={phrase('Find')}
          value={fields.search}
          spellCheck={false}
          onChange={(event) => {
            const search = event.target.value;
            setFields((current) => ({ ...current, search }));
            change({ search });
          }}
          className={INPUT}
        />
        {/* The count gives its room to the query while the field is narrow. */}
        {status !== null && (
          <span
            role="status"
            className={`hidden shrink-0 text-[11px] whitespace-nowrap tabular-nums @min-[15rem]:inline ${status.invalid ? 'text-del' : 'text-faint'}`}
          >
            {status.text}
          </span>
        )}
        <Toggle
          label={phrase('match case')}
          pressed={query.caseSensitive}
          onToggle={() => {
            change({ caseSensitive: !getSearchQuery(view.state).caseSensitive });
          }}
        >
          <CaseSensitive className="size-3.5" />
        </Toggle>
        <Toggle
          label={phrase('by word')}
          pressed={query.wholeWord}
          onToggle={() => {
            change({ wholeWord: !getSearchQuery(view.state).wholeWord });
          }}
        >
          <WholeWord className="size-3.5" />
        </Toggle>
        <Toggle
          label={phrase('regexp')}
          pressed={query.regexp}
          onToggle={() => {
            change({ regexp: !getSearchQuery(view.state).regexp });
          }}
        >
          <Regex className="size-3.5" />
        </Toggle>
      </Field>
      <div className="flex items-center gap-1">
        <IconButton
          label={phrase('previous')}
          onClick={() => {
            findPrevious(view);
          }}
        >
          <ChevronUp className="size-4" />
        </IconButton>
        <IconButton
          label={phrase('next')}
          onClick={() => {
            findNext(view);
          }}
        >
          <ChevronDown className="size-4" />
        </IconButton>
        <TextButton
          onClick={() => {
            // The matches become the editor's selections, which the keyboard then edits together: the
            // editor takes the focus first, so that its own selection does not replace them.
            view.focus();
            selectMatches(view);
          }}
        >
          {phrase('all')}
        </TextButton>
      </div>
      <div className="col-start-4">
        <IconButton
          label={phrase('close')}
          onClick={() => {
            closeSearchPanel(view);
          }}
        >
          <X className="size-4" />
        </IconButton>
      </div>
      {!state.readOnly && (
        <>
          <Field>
            <Replace className="size-3.5 shrink-0 text-faint" />
            <input
              name="replace"
              aria-label={phrase('Replace with')}
              placeholder={phrase('Replace')}
              value={fields.replace}
              spellCheck={false}
              onChange={(event) => {
                const replace = event.target.value;
                setFields((current) => ({ ...current, replace }));
                change({ replace });
              }}
              className={INPUT}
            />
          </Field>
          <div className="flex items-center gap-1">
            <TextButton
              onClick={() => {
                replaceNext(view);
              }}
            >
              {phrase('replace')}
            </TextButton>
            <TextButton
              onClick={() => {
                replaceAll(view);
              }}
            >
              {phrase('replace all')}
            </TextButton>
          </div>
        </>
      )}
    </div>
  );
}

// What the bar says of the query's matches: none while it is empty, that a regular expression does not
// parse, that nothing matches, which match is selected of how many, or how many there are.
function statusOf(
  query: SearchQuery,
  counted: Counted | null,
  phrase: (text: string, ...insert: unknown[]) => string,
): { text: string; invalid: boolean } | null {
  if (query.search === '') return null;
  if (counted === null) return { text: phrase('Invalid'), invalid: true };
  if (counted.total === 0) return { text: phrase('No results'), invalid: false };
  const total = `${String(counted.total)}${counted.more ? '+' : ''}`;
  return {
    text:
      counted.current === null
        ? phrase('$ found', total)
        : phrase('$1 of $2', counted.current, total),
    invalid: false,
  };
}

const INPUT =
  'min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:font-sans placeholder:text-placeholder';

// A field of the bar, as the app's search field is drawn: a box under a dashed line, which turns solid
// in the accent while the field has the focus, and in red while what it holds does not parse.
function Field({ invalid = false, children }: { invalid?: boolean; children: ReactNode }) {
  return (
    <div
      className={`@container flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-dashed px-2 focus-within:border-solid ${invalid ? 'border-del' : 'border-menu-line focus-within:border-accent'}`}
    >
      {children}
    </div>
  );
}

// A pressed button keeps the focus where it was, in a field or the editor, so that typing goes on
// there.
const keepFocus = (event: { preventDefault: () => void }) => {
  event.preventDefault();
};

// An option of the query, inside the field: drawn in ink while it is on.
function Toggle({
  label,
  pressed,
  onToggle,
  children,
}: {
  label: string;
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onMouseDown={keepFocus}
      onClick={onToggle}
      className={`grid size-5 shrink-0 place-items-center rounded-sm ${pressed ? 'bg-selected text-ink' : 'text-faint hover:bg-hover hover:text-ink'}`}
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={keepFocus}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink"
    >
      {children}
    </button>
  );
}

// A command in words, as the app's other buttons beside a field are drawn.
function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={keepFocus}
      onClick={onClick}
      className="h-7 shrink-0 rounded-md border border-line px-2.5 text-[12px] whitespace-nowrap text-ink hover:bg-hover active:bg-selected"
    >
      {children}
    </button>
  );
}
