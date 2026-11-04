import { memo, useMemo, type ReactNode } from 'react';
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type UrlTransform,
} from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import './markdown.css';
import { withMathDelimiters } from './math-delimiters';

// An image carried in a data URL.
const dataImage = /^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/;

// A link the window opens in the browser.
const webLink = /^(https?|mailto):/i;

export interface MarkdownProps {
  text: string;
  // Draws an image of the text, by its address and alternative text; without it, an image is a link
  // to its address, never fetched.
  image?: (src: string, alt: string) => ReactNode;
  // Follows a link that is neither a web link nor a link within the text, such as a path to another
  // file; without it, the window leaves such a link alone.
  onLink?: (href: string) => void;
  // A document's headings, each a size of its own, as a file shows; otherwise the activity's, at the
  // text's size.
  document?: boolean;
}

// How each element looks, in the type of whatever holds the text.
function componentsFor({
  image,
  onLink,
  document = false,
}: Omit<MarkdownProps, 'text'>): Components {
  const link = (href: string | undefined, children: ReactNode) => (
    <a
      href={href}
      onClick={(event) => {
        if (onLink === undefined || href === undefined) return;
        if (webLink.test(href) || href.startsWith('#')) return;
        event.preventDefault();
        onLink(href);
      }}
      className="text-accent underline underline-offset-2"
    >
      {children}
    </a>
  );
  return {
    p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
    ...(document
      ? {
          h1: ({ children }) => (
            <h1 className="mt-6 mb-3 text-[20px] leading-tight font-bold first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-5 mb-2 text-[16px] leading-snug font-bold first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-4 mb-2 text-[14px] font-bold first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => <h4 className="mt-3 mb-1.5 font-bold first:mt-0">{children}</h4>,
        }
      : {
          h1: ({ children }) => <h3 className="mt-4 mb-2 font-medium first:mt-0">{children}</h3>,
          h2: ({ children }) => <h3 className="mt-4 mb-2 font-medium first:mt-0">{children}</h3>,
          h3: ({ children }) => <h3 className="mt-3 mb-1.5 font-medium first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 className="mt-3 mb-1.5 font-medium first:mt-0">{children}</h4>,
        }),
    ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
    li: ({ children }) => <li className="my-0.5">{children}</li>,
    a: ({ children, href }) => link(href, children),
    blockquote: ({ children }) => (
      <blockquote className="my-2 rounded-sm border-l-[3px] border-line bg-well py-1 pr-2 pl-3 text-muted">
        {children}
      </blockquote>
    ),
    pre: ({ children }) => (
      <pre className="my-2 overflow-x-auto rounded-md border border-dashed border-line bg-well px-3 py-2">
        {children}
      </pre>
    ),
    code: ({ children, className }) => (
      <code className={className ?? 'rounded bg-well px-1 py-px'}>{children}</code>
    ),
    table: ({ children }) => (
      <div className="my-2 overflow-x-auto">
        <table className="border-collapse">{children}</table>
      </div>
    ),
    // A column's alignment comes in its cells' style.
    th: ({ children, style }) => (
      <th style={style} className="border border-line bg-well px-2 py-1 text-left font-medium">
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td style={style} className="border border-line px-2 py-1">
        {children}
      </td>
    ),
    hr: () => <hr className="my-3 border-line" />,
    img: ({ src, alt }) => {
      const address = typeof src === 'string' ? src : '';
      if (address === '') return null;
      if (image !== undefined) return image(address, alt ?? '');
      return link(address, alt === undefined || alt === '' ? address : alt);
    },
  };
}

// Addresses as react-markdown keeps them, and an image's data URL besides.
const urlTransform: UrlTransform = (url, key, node) =>
  key === 'src' && node.tagName === 'img' && dataImage.test(url) ? url : defaultUrlTransform(url);

// Math set by KaTeX: an error shows in place, in the removed lines' red, rather than stopping the
// text, and commands that would load or link anything are refused (KaTeX's trust stays off).
const katex = { throwOnError: false, strict: 'ignore', errorColor: 'var(--del)' } as const;
// Code highlighted by highlight.js where its block names its language; a block that names none, or a
// language it does not know, stays plain.
const highlight = { detect: false, plainText: ['text', 'txt', 'plain', 'plaintext'] };

// Text as Markdown (ADR-0010, ADR-0018), with GitHub's tables, task lists, strikethrough and
// footnotes, math in any of the delimiters models write (withMathDelimiters), and highlighted code.
// Raw HTML in it is left out rather than rendered, and unsafe link addresses are dropped; a web link
// opens in the default browser, as the app's other links do.
export const Markdown = memo(function Markdown({ text, image, onLink, document }: MarkdownProps) {
  const components = useMemo(
    () =>
      componentsFor({
        ...(image === undefined ? {} : { image }),
        ...(onLink === undefined ? {} : { onLink }),
        ...(document === undefined ? {} : { document }),
      }),
    [image, onLink, document],
  );
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[
        [rehypeKatex, katex],
        [rehypeHighlight, highlight],
      ]}
      components={components}
      urlTransform={urlTransform}
    >
      {withMathDelimiters(text)}
    </ReactMarkdown>
  );
});
