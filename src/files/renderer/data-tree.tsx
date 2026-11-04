import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from '../../ui/renderer/icons';
import type { DataNode } from './formats';

// How many entries of an object, array or element show before Show More, and at each press of it.
export const PAGE = 200;
// The levels open as the tree first shows: the root's entries, and theirs.
const OPEN_LEVELS = 2;

// The colour of a value by its type, from the syntax colours of the tokens.
const valueColours = {
  string: 'text-[var(--syntax-string)]',
  number: 'text-[var(--syntax-number)]',
  boolean: 'text-[var(--syntax-constant)]',
  null: 'text-[var(--syntax-constant)]',
  date: 'text-[var(--syntax-constant)]',
} as const;

// A data file as a folding tree (ADR-0018), as browsers show JSON and XML: objects, arrays and
// elements fold and unfold, a folded one saying how many entries it holds, keys and attributes in
// ink, values in the syntax colours by type, and the first two levels open. Each holds its entries a
// page at a time.
export function DataTree({ root }: { root: DataNode }) {
  return (
    <ul role="tree" className="font-mono text-[12px]/[1.7] text-ink select-text">
      <TreeEntry node={root} label={null} level={0} />
    </ul>
  );
}

function TreeEntry({
  node,
  label,
  level,
}: {
  node: DataNode;
  label: string | null;
  level: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(level < OPEN_LEVELS);
  const [shown, setShown] = useState(PAGE);
  const children = childrenOf(node);
  const key =
    label === null ? null : (
      <>
        <span className="text-ink">{label}</span>
        <span className="text-faint">: </span>
      </>
    );
  if (children === null) {
    return (
      <li
        role="treeitem"
        aria-selected={false}
        className="pl-[18px] break-words whitespace-pre-wrap"
      >
        {key}
        <Leaf node={node} />
      </li>
    );
  }
  const count = children.length;
  return (
    <li role="treeitem" aria-selected={false} aria-expanded={open}>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
        }}
        className="flex max-w-full items-start gap-0.5 rounded-sm text-left hover:bg-hover"
      >
        <span className="mt-[3px] grid size-4 shrink-0 place-items-center text-faint">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
        <span className="min-w-0 break-words">
          {key}
          <Opening node={node} />
          {!open && (
            <span className="text-faint">
              {' '}
              {t('files.tree.count', { count })}
              {closingOf(node)}
            </span>
          )}
        </span>
      </button>
      {open && (
        <ul role="group" className="ml-[7px] border-l border-dashed border-line pl-[9px]">
          {children.slice(0, shown).map(([childLabel, child], index) => (
            <TreeEntry key={index} node={child} label={childLabel} level={level + 1} />
          ))}
          {count > shown && (
            <li>
              <button
                type="button"
                onClick={() => {
                  setShown(shown + PAGE);
                }}
                className="ml-[18px] rounded-sm px-1 text-faint hover:bg-hover hover:text-ink"
              >
                {t('files.tree.more', {
                  count: Math.min(PAGE, count - shown),
                  left: count - shown,
                })}
              </button>
            </li>
          )}
          <li className="pl-[18px] text-faint">{closingOf(node)}</li>
        </ul>
      )}
    </li>
  );
}

// What an object, array or element holds, each entry with its label: a key, an index, or none for
// an element's children; null for a value.
function childrenOf(node: DataNode): [string | null, DataNode][] | null {
  switch (node.kind) {
    case 'object':
      return node.entries;
    case 'array':
      return node.items.map((item, index) => [String(index), item]);
    case 'element':
      return node.children.map((child) => [null, child]);
    default:
      return null;
  }
}

// How an object, array or element opens: its brace, its bracket, or its start tag with its
// attributes.
function Opening({ node }: { node: DataNode }): ReactNode {
  switch (node.kind) {
    case 'object':
      return <span className="text-faint">{'{'}</span>;
    case 'array':
      return <span className="text-faint">{'['}</span>;
    case 'element':
      return (
        <>
          <span className="text-faint">{'<'}</span>
          <span className="text-[var(--syntax-keyword)]">{node.name}</span>
          {node.attributes.map(([name, value]) => (
            <span key={name}>
              {' '}
              <span className="text-ink">{name}</span>
              <span className="text-faint">=</span>
              <span className={valueColours.string}>"{value}"</span>
            </span>
          ))}
          <span className="text-faint">{'>'}</span>
        </>
      );
    default:
      return null;
  }
}

function closingOf(node: DataNode): string {
  switch (node.kind) {
    case 'object':
      return '}';
    case 'array':
      return ']';
    case 'element':
      return `</${node.name}>`;
    default:
      return '';
  }
}

// A value in its type's colour, a string in quotes; an element's text as it is.
function Leaf({ node }: { node: DataNode }) {
  if (node.kind === 'text') return <span>{node.text}</span>;
  if (node.kind !== 'value') return null;
  return (
    <span className={valueColours[node.type]}>
      {node.type === 'string' ? JSON.stringify(node.text) : node.text}
    </span>
  );
}
