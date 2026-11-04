import { useEffect, useState } from 'react';
import { searchWords } from '../shared/search';
import type { SessionsBridge, SessionSummary } from '../shared/sessions';

// How long typing pauses, in milliseconds, before a search is asked for.
const SEARCH_AFTER = 150;
// How often a search is asked for again while the app still reads sessions for searching.
const SEARCH_AGAIN = 2_000;

export interface SessionsFound {
  // Whether there is a query to search for.
  searching: boolean;
  // Whether it is known that no session of the list matches the query: the main process, having read
  // every session, found none for it, or for a query it only lengthens, which finds no more.
  none: boolean;
  // The sessions found, in the list's order.
  sessions: SessionSummary[];
  // The passage of each session's conversation that matched, by the app's id.
  snippets: ReadonlyMap<string, string>;
  // How many sessions of the list the app has not read yet.
  unread: number;
}

// The sessions of a list, the Sessions list's or the archived list's, that a query finds: those whose
// title and conversation hold every word of it, whatever its case, as the main process finds them. It
// is asked once typing pauses, and again while it still reads sessions for searching. Until it answers
// the query as it is now, what was found stands: its answer to the query typed before, when this one
// grew or shrank from it, and otherwise the whole list, so that the list changes once an answer comes
// and never says that nothing matches before the main process knows it. An empty query finds the whole
// list.
export function useSessionSearch(
  bridge: Pick<SessionsBridge, 'search'>,
  sessions: SessionSummary[],
  query: string,
  archived: boolean,
): SessionsFound {
  const searching = searchWords(query).length > 0;
  const [answer, setAnswer] = useState<{
    query: string;
    found: ReadonlyMap<string, string | undefined>;
    unread: number;
  } | null>(null);

  useEffect(() => {
    if (!searching) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      bridge.search(query, archived).then((search) => {
        if (!live) return;
        setAnswer({
          query,
          found: new Map(search.matches.map((match) => [match.id, match.snippet])),
          unread: search.unread,
        });
        if (search.unread > 0) timer = setTimeout(ask, SEARCH_AGAIN);
      }, report);
    };
    timer = setTimeout(ask, SEARCH_AFTER);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [bridge, query, archived, searching]);

  const whole = { sessions, snippets: new Map<string, string>(), unread: 0 };
  if (!searching) return { searching, none: false, ...whole };
  const standing =
    answer !== null && (query.startsWith(answer.query) || answer.query.startsWith(query))
      ? answer
      : null;
  if (standing === null) return { searching, none: false, ...whole };
  const snippets = new Map<string, string>();
  const found = sessions.filter((session) => {
    if (!standing.found.has(session.id)) return false;
    const snippet = standing.found.get(session.id);
    if (snippet !== undefined) snippets.set(session.id, snippet);
    return true;
  });
  return {
    searching,
    // Each word of a query that lengthens another holds one of the other's, so it finds no more.
    none: found.length === 0 && standing.unread === 0 && query.startsWith(standing.query),
    sessions: found,
    snippets,
    unread: standing.unread,
  };
}

function report(error: unknown): void {
  console.error('The sessions could not be searched:', error);
}
