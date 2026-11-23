// The tools agents call, as the activity names them: the app's own toolset's name, a call of an MCP
// tool in the terms every provider shares, and a tool's name in words.

// The app's own toolset, as the providers list it (ADR-0023); Grok Build knows it by another name,
// which its adapter maps.
export const TOOLSET_NAME = '3mukon-code';

// A call of an MCP tool: its server, which for the app's own toolset is TOOLSET_NAME whatever the
// provider calls it, and its tool, as the provider names them.
export interface McpCall {
  server: string;
  tool: string;
  // Whether the tool is one of the app's own, which the activity names in its own words.
  app?: true;
  // For one of the app's tools whose arguments choose what it does, which of its words fit the call,
  // such as reading one message rather than the inbox.
  action?: string;
  // What the call acts on, in a few words from its arguments, such as a message's summary.
  subject?: string;
}

// How long a call's subject may run, in characters, cut at the end with an ellipsis beyond.
const SUBJECT_LENGTH = 80;

// A call of a server's tool, with its arguments, which for one of the app's own tools give its action
// and subject.
export function mcpCall(server: string, tool: string, input: unknown): McpCall {
  return server === TOOLSET_NAME ? appCall(tool, input) : { server, tool };
}

// A call of one of the app's own tools.
export function appCall(tool: string, input: unknown): McpCall {
  const args =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const said = (field: string) => short(oneLine(args[field]));
  const call: McpCall = { server: TOOLSET_NAME, tool, app: true };
  switch (tool) {
    case 'session_start':
      return withSubject(call, said('title') ?? short(firstLine(args.prompt)));
    case 'message_send':
      return withSubject(call, said('summary'));
    case 'message_read':
      return args.messageId === undefined ? { ...call, action: 'message_read_inbox' } : call;
    case 'panel_present':
    case 'panel_update':
      return withSubject(call, said('title'));
    case 'browser_navigate':
      return withSubject(call, said('url'));
    default:
      return call;
  }
}

// A tool's name in words, for a tool the activity has no words of its own for: snake_case,
// kebab-case and camelCase split, the first word as it is and the others in lower case where they are
// not all capitals, such as Enter plan mode for EnterPlanMode or create issue for create_issue.
export function toolWords(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter((word) => word !== '');
  return words
    .map((word, index) =>
      index === 0 || /^[A-Z0-9]+$/.test(word) ? word : word.charAt(0).toLowerCase() + word.slice(1),
    )
    .join(' ');
}

function withSubject(call: McpCall, subject: string | undefined): McpCall {
  return subject === undefined ? call : { ...call, subject };
}

function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function firstLine(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.split('\n').find((line) => line.trim() !== '') ?? '';
}

function short(text: string): string | undefined {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '') return undefined;
  return line.length > SUBJECT_LENGTH ? `${line.slice(0, SUBJECT_LENGTH - 1).trimEnd()}…` : line;
}
