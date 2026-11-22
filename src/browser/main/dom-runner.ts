/// <reference lib="dom" />
import { z } from 'zod';
import type { PageAction } from './page';

export const viewport = z.object({
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  x: z.number(),
  y: z.number(),
});
export const observation = viewport.omit({ x: true, y: true }).extend({
  text: z.string().max(2001),
  truncated: z.boolean(),
  elements: z
    .array(
      z.object({
        ref: z.number().int().min(1).max(64),
        role: z.string().max(16),
        label: z.string().max(100),
      }),
    )
    .max(64),
});
export const actionOutcome = z.union([
  z.object({ status: z.literal('verified'), value: z.null() }),
  z.object({ status: z.literal('dispatched'), evidence: z.literal('not-verified') }),
  z.object({
    status: z.literal('refused'),
    code: z.enum(['stale-observation', 'invalid-request']),
    dispatched: z.literal(false),
  }),
]);

type Request =
  | { kind: 'viewport' }
  | { kind: 'observe'; marker: string }
  | {
      kind: 'action';
      marker: string;
      action: PageAction;
      outsideApp?: true;
      blockDocumentNavigation?: true;
    };

// Serialized as a fixed script into an isolated world. Everything it uses is defined here or is a
// DOM builtin. Arguments are data, and element references never turn into selectors or source.
export function inPage(request: Request) {
  interface Entry {
    node: HTMLElement;
    role: string;
    label: string;
    destination: string | null;
    rect: number[];
  }
  interface Remembered {
    marker: string;
    width: number;
    height: number;
    x: number;
    y: number;
    entries: Entry[];
  }
  const scope = globalThis as typeof globalThis & { embeddedObservation?: Remembered };
  const viewport = { width: innerWidth, height: innerHeight, x: scrollX, y: scrollY };
  if (request.kind === 'viewport') return viewport;

  function visible(node: HTMLElement): boolean {
    let depth = 0;
    for (let item: HTMLElement | null = node; item; item = item.parentElement) {
      if (++depth > 64) return false;
      if (item.hidden || item.inert || item.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(item);
      if (style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0')
        return false;
    }
    return true;
  }

  function rect(node: HTMLElement): number[] {
    const box = node.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height];
  }

  function controlText(node: HTMLElement): string {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text = '';
    for (let index = 0; index < 20 && text.length < 100; index++) {
      const next = walker.nextNode();
      if (!next) break;
      text += next.textContent?.slice(0, 100 - text.length) ?? '';
    }
    return text;
  }

  function entry(node: HTMLElement): Entry | null {
    if (node.matches(':disabled, [aria-disabled="true"]') || !visible(node)) return null;
    // Limit actions to the supported native controls.
    let role: string;
    let destination: string | null = null;
    if (node instanceof HTMLInputElement) {
      if (['text', 'search', 'email', 'tel', 'url', 'number'].includes(node.type)) role = 'textbox';
      else if (['button', 'submit', 'reset'].includes(node.type)) role = 'button';
      else if (['checkbox', 'radio'].includes(node.type)) role = node.type;
      else return null;
    } else if (node instanceof HTMLTextAreaElement) role = 'textbox';
    else if (node instanceof HTMLButtonElement) role = 'button';
    else if (
      node instanceof HTMLAnchorElement &&
      node.hasAttribute('href') &&
      !node.hasAttribute('download')
    ) {
      if (node.href.length > 4096 || !URL.canParse(node.href)) return null;
      const url = new URL(node.href);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
      destination = url.href;
      role = 'link';
    } else return null;
    const label = (
      node.getAttribute('aria-label') ??
      node.getAttribute('title') ??
      (role === 'textbox' ? node.getAttribute('placeholder') : null) ??
      (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
        ? ''
        : controlText(node))
    )
      .slice(0, 100)
      .trim();
    const bounds = rect(node);
    const [x, y, width, height] = bounds;
    if (
      x === undefined ||
      y === undefined ||
      !width ||
      !height ||
      x + width <= 0 ||
      y + height <= 0 ||
      x >= innerWidth ||
      y >= innerHeight
    )
      return null;
    return { node, role, label, destination, rect: bounds };
  }

  if (request.kind === 'observe') {
    const entries: Entry[] = [];
    let text = '';
    let remaining = 1600;
    let truncated = false;
    const root = document.querySelector('body');
    if (root) {
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            if (
              node instanceof HTMLElement &&
              node.matches('script,style,template,noscript,textarea,select,[contenteditable]')
            )
              return node instanceof HTMLTextAreaElement
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );
      let current: Node | null;
      while ((current = walker.nextNode()) !== null) {
        if (--remaining < 0) {
          truncated = true;
          break;
        }
        if (current instanceof HTMLElement && entries.length < 64) {
          const item = entry(current);
          if (item) entries.push(item);
        }
        if (current.nodeType !== Node.TEXT_NODE || text.length >= 2000) continue;
        const parent = current.parentElement;
        if (!parent || parent.closest('textarea,select,[contenteditable]') || !visible(parent))
          continue;
        const part = current.textContent?.slice(0, 2000 - text.length).trim();
        if (part) text += (text ? ' ' : '') + part;
      }
    }
    scope.embeddedObservation = { marker: request.marker, ...viewport, entries };
    return {
      width: viewport.width,
      height: viewport.height,
      text,
      truncated: truncated || text.length >= 2000 || entries.length >= 64,
      elements: entries.map(({ role, label }, index) => ({ ref: index + 1, role, label })),
    };
  }

  const old = scope.embeddedObservation;
  delete scope.embeddedObservation;
  const stale = { status: 'refused', code: 'stale-observation', dispatched: false } as const;
  if (
    old?.marker !== request.marker ||
    old.width !== innerWidth ||
    old.height !== innerHeight ||
    old.x !== scrollX ||
    old.y !== scrollY
  )
    return stale;
  const action = request.action;
  if (action.kind === 'scroll') {
    const start = scrollY;
    window.scrollBy({ top: action.deltaY, behavior: 'instant' });
    return start === scrollY
      ? ({ status: 'dispatched', evidence: 'not-verified' } as const)
      : ({ status: 'verified', value: null } as const);
  }
  const seen = old.entries[action.element - 1];
  if (!seen?.node.isConnected || seen.node.ownerDocument !== document) return stale;
  const current = entry(seen.node);
  if (
    current?.role !== seen.role ||
    current.label !== seen.label ||
    current.destination !== seen.destination ||
    current.rect.some((value, index) => value !== seen.rect[index])
  )
    return stale;
  const box = seen.node.getBoundingClientRect();
  const target = document.elementFromPoint(
    (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2,
    (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2,
  );
  if (!target || !seen.node.contains(target)) return stale;
  if (action.kind === 'click') {
    const node = seen.node;
    const form =
      node instanceof HTMLButtonElement || node instanceof HTMLInputElement ? node.form : null;
    if (request.blockDocumentNavigation) {
      let navigates =
        !!form &&
        (node instanceof HTMLButtonElement || node instanceof HTMLInputElement) &&
        (node.type === 'submit' || node.type === 'image');
      if (node instanceof HTMLAnchorElement) {
        const current = new URL(document.URL);
        const link = new URL(node.href);
        const hasFragment = !!link.hash;
        current.hash = link.hash = '';
        navigates = !hasFragment || current.href !== link.href;
      }
      if (navigates)
        return { status: 'refused', code: 'background-unavailable', dispatched: false } as const;
    }
    if (request.outsideApp) {
      const explicitTarget =
        node instanceof HTMLAnchorElement
          ? node.target
          : (node.getAttribute('formtarget') ?? form?.target);
      const defaultTarget = document.querySelector('base[target]')?.getAttribute('target');
      const targetName = [explicitTarget, defaultTarget].find(Boolean);
      if (targetName && targetName.toLowerCase() !== '_self')
        return { status: 'refused', code: 'invalid-request', dispatched: false } as const;
    }
    seen.node.click();
    return { status: 'dispatched', evidence: 'not-verified' } as const;
  }
  const field = seen.node;
  if (
    seen.role !== 'textbox' ||
    !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) ||
    field.readOnly
  )
    return { status: 'refused', code: 'invalid-request', dispatched: false } as const;
  field.value = action.text;
  field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  return field.value === action.text
    ? ({ status: 'verified', value: null } as const)
    : ({ status: 'dispatched', evidence: 'not-verified' } as const);
}
