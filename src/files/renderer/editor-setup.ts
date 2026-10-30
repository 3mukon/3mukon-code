import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
  type LanguageSupport,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { countColumn, EditorState, RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

// The words CodeMirror shows and announces, in its search panel, its folding and its announcements
// for VoiceOver, each with its key under the catalog's files.editor.
export const PHRASES = {
  'Control character': 'controlCharacter',
  close: 'close',
  Find: 'find',
  Replace: 'replace',
  next: 'next',
  previous: 'previous',
  all: 'all',
  'match case': 'matchCase',
  regexp: 'regexp',
  'by word': 'byWord',
  replace: 'replaceOne',
  'replace all': 'replaceAll',
  'current match': 'currentMatch',
  'on line': 'onLine',
  'replaced $ matches': 'replacedMatches',
  'replaced match on line $': 'replacedMatchOnLine',
  'Go to line': 'goToLine',
  go: 'go',
  'Selection deleted': 'selectionDeleted',
  'folded code': 'foldedCode',
  unfold: 'unfold',
  to: 'to',
  'Folded lines': 'foldedLines',
  'Unfolded lines': 'unfoldedLines',
  'Fold line': 'foldLine',
  'Unfold line': 'unfoldLine',
} as const;

const mono = 'ui-monospace, monospace';
const tinted = (token: string, share: number) =>
  `color-mix(in srgb, var(${token}) ${String(share)}%, transparent)`;

// The editor in the ui module's tokens, so that it follows the light and the dark appearance as the
// rest of the window does: in the activity's small monospaced type, on the panel's own paper, with
// dashed lines around its search panel as around the activity's code.
const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--ink)', backgroundColor: 'transparent', fontSize: '12.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: mono, lineHeight: '1.75' },
  '.cm-content': { padding: '4px 0 24px', caretColor: 'var(--ink)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: tinted('--accent', 24) },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--faint)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 20px' },
  // The line with the cursor stands out while the editor has focus, as the cursor shows only then.
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLineGutter': { color: 'var(--muted)' },
  // The fold markers show while the pointer is over the gutter; a folded range shows in the text.
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', cursor: 'default', opacity: '0' },
  '.cm-gutters:hover .cm-foldGutter .cm-gutterElement': { opacity: '1' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--well)',
    border: '1px dashed var(--line)',
    color: 'var(--muted)',
  },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: tinted('--accent', 18) },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: tinted('--del', 22) },
  '.cm-selectionMatch': { backgroundColor: tinted('--wait', 18) },
  '.cm-searchMatch': {
    backgroundColor: tinted('--wait', 28),
    outline: `1px solid ${tinted('--wait', 55)}`,
  },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: tinted('--accent', 30) },
  '.cm-specialChar': { color: 'var(--del)' },
  '.cm-panels': { backgroundColor: 'var(--pane)', color: 'var(--ink)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px dashed var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px dashed var(--line)' },
  '.cm-panel.cm-search, .cm-panel.cm-gotoLine': { padding: '6px 20px', fontSize: '11.5px' },
  '.cm-panel.cm-search label': { color: 'var(--muted)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--faint)', right: '10px' },
  '.cm-textfield': {
    backgroundColor: 'var(--well)',
    border: '1px dashed var(--line)',
    borderRadius: '4px',
    color: 'var(--ink)',
    fontFamily: mono,
  },
  '.cm-textfield:focus': { outline: '1px solid var(--accent)', outlineOffset: '-1px' },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'transparent',
    border: '1px solid var(--line)',
    borderRadius: '4px',
    color: 'var(--ink)',
  },
  '.cm-button:hover': { backgroundColor: 'var(--hover)' },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--selected)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--menu)',
    border: '1px solid var(--menu-line)',
    boxShadow: 'var(--menu-shadow)',
    color: 'var(--ink)',
  },
});

// Code in the ui module's syntax colours, as the activity's code has them.
const highlightStyle = HighlightStyle.define([
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: 'var(--syntax-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.modifier,
    ],
    color: 'var(--syntax-keyword)',
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.definition(tags.variableName)),
      tags.function(tags.propertyName),
      tags.macroName,
    ],
    color: 'var(--syntax-function)',
  },
  { tag: tags.heading, color: 'var(--syntax-function)', fontWeight: '600' },
  {
    tag: [tags.bool, tags.null, tags.atom, tags.constant(tags.variableName)],
    color: 'var(--syntax-constant)',
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape, tags.character],
    color: 'var(--syntax-string)',
  },
  {
    tag: [tags.propertyName, tags.attributeName, tags.special(tags.variableName), tags.labelName],
    color: 'var(--syntax-variable)',
  },
  { tag: [tags.number, tags.integer, tags.float], color: 'var(--syntax-number)' },
  {
    tag: [
      tags.typeName,
      tags.className,
      tags.namespace,
      tags.tagName,
      tags.standard(tags.variableName),
      tags.self,
      tags.meta,
      tags.annotation,
      tags.processingInstruction,
    ],
    color: 'var(--syntax-feature)',
  },
  { tag: tags.invalid, color: 'var(--syntax-invalid)' },
  { tag: tags.inserted, color: 'var(--add)' },
  { tag: tags.deleted, color: 'var(--del)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], textDecoration: 'underline' },
]);

// A wrapped line goes on at its own indentation, as editors that wrap code do, rather than at the
// line's start: the lines in view are each indented by their leading whitespace, which their first
// row takes back. CodeMirror's own 6px stays before every line.
const wrappedIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = indentsOf(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = indentsOf(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const indents = new Map<number, Decoration>();

function indentsOf(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    for (let position = from; position <= to;) {
      const line = view.state.doc.lineAt(position);
      position = line.to + 1;
      if (line.number === last) continue;
      last = line.number;
      const leading = /^[ \t]*/.exec(line.text)?.[0] ?? '';
      const columns = countColumn(leading, view.state.tabSize);
      if (columns === 0 || leading.length === line.length) continue;
      let indent = indents.get(columns);
      if (indent === undefined) {
        indent = Decoration.line({
          attributes: {
            style: `padding-left: calc(${String(columns)}ch + 6px); text-indent: -${String(columns)}ch`,
          },
        });
        indents.set(columns, indent);
      }
      builder.add(line.from, line.from, indent);
    }
  }
  return builder.finish();
}

// The editor's own setup, assembled from CodeMirror's parts: line numbers, folding, history, bracket
// matching and closing, several selections, search and replace and Go to line, Tab to indent
// (Escape, then Tab, moves the focus on), and long lines wrapped at the panel's width at their own
// indentation, in the tokens' look and the given words. ⌘D stays the panel area's, which splits the panel, rather than selecting
// the next match.
export function editorSetup(phrases: Readonly<Record<string, string>>, label: string): Extension {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(highlightStyle),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    wrappedIndent,
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap.filter((binding) => binding.key !== 'Mod-d'),
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    theme,
    EditorState.phrases.of(phrases),
    EditorView.contentAttributes.of({ 'aria-label': label }),
  ];
}

// The language a file's name calls for, among those CodeMirror's language data describes, loaded from
// the app's own files; null for a name none of them matches, which stays plain text.
export async function languageFor(name: string): Promise<LanguageSupport | null> {
  const description = LanguageDescription.matchFilename(languages, name);
  return description === null ? null : description.load();
}
