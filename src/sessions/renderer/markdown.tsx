import { memo } from 'react';
import { useTranslation } from 'react-i18next';
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
import type { MessageImage } from '../shared/events';
import { Thumbnail } from './images';
import { withMathDelimiters } from './math-delimiters';

// An image the message carries in a data URL.
const dataImage = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;

// How each element looks in a session's activity, in its small monospaced type.
const components: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className="mt-4 mb-2 font-medium first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 mb-2 font-medium first:mt-0">{children}</h3>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 font-medium first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 mb-1.5 font-medium first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  a: ({ children, href }) => (
    <a href={href} className="text-accent underline underline-offset-2">
      {children}
    </a>
  ),
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
  img: ({ src, alt }) => <MarkdownImage src={typeof src === 'string' ? src : ''} alt={alt ?? ''} />,
};

// An image in the message: one it carries shows as the timeline's other images do; one elsewhere, as
// on the web, is not fetched and shows as a link to it.
function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const { t } = useTranslation();
  const [, mediaType, data] = dataImage.exec(src) ?? [];
  if (mediaType !== undefined && data !== undefined) {
    const image: MessageImage = { mediaType, data };
    return (
      <Thumbnail image={image} label={alt === '' ? t('sessions.image.alt', { index: 1 }) : alt} />
    );
  }
  if (src === '') return null;
  return (
    <a href={src} className="text-accent underline underline-offset-2">
      {alt === '' ? src : alt}
    </a>
  );
}

// Addresses as react-markdown keeps them, and an image's data URL besides.
const urlTransform: UrlTransform = (url, key, node) =>
  key === 'src' && node.tagName === 'img' && dataImage.test(url) ? url : defaultUrlTransform(url);

// Math set by KaTeX: an error shows in place, in the removed lines' red, rather than stopping the
// message, and commands that would load or link anything are refused (KaTeX's trust stays off).
const katex = { throwOnError: false, strict: 'ignore', errorColor: 'var(--del)' } as const;
// Code highlighted by highlight.js where its block names its language; a block that names none, or a
// language it does not know, stays plain.
const highlight = { detect: false, plainText: ['text', 'txt', 'plain', 'plaintext'] };

// A message as Markdown, with GitHub's tables, task lists, strikethrough and footnotes, math in any of
// the delimiters models write (withMathDelimiters), and highlighted code. It is text from the agent or
// the user, so raw HTML in it is left out rather than rendered and unsafe link addresses are dropped; a
// web link opens in the default browser, as the app's other links do.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
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
