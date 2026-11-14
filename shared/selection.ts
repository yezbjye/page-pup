import type { SourceSegment } from './types';

const BLOCK_SELECTOR = 'p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, td, th, dd, dt';
const PRIVATE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-page-pup-private]';
export const MAX_SELECTION_CHARACTERS = 12000;
export const MAX_SELECTION_SEGMENTS = 12;

export interface SelectionSnapshot {
  text: string;
  segments: SourceSegment[];
  ranges: Range[];
}

export type SelectionRejection = 'empty' | 'private' | 'too-long' | 'too-many-segments';

export type SelectionCapture =
  | { snapshot: SelectionSnapshot; rejection?: never }
  | { snapshot?: never; rejection: SelectionRejection };

function asElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

function touchesPrivateContent(range: Range, root: Element | null): boolean {
  if (asElement(range.startContainer)?.closest(PRIVATE_SELECTOR)) return true;
  if (asElement(range.endContainer)?.closest(PRIVATE_SELECTOR)) return true;
  if (asElement(range.commonAncestorContainer)?.closest(PRIVATE_SELECTOR)) return true;
  if (!root) return false;
  return Array.from(root.querySelectorAll(PRIVATE_SELECTOR)).some((element) => range.intersectsNode(element));
}

export function captureSelection(selection: Selection | null): SelectionCapture {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return { rejection: 'empty' };
  const range = selection.getRangeAt(0);
  const commonElement = asElement(range.commonAncestorContainer);
  if (commonElement?.closest('#page-pup-host')) return { rejection: 'empty' };
  if (touchesPrivateContent(range, commonElement)) return { rejection: 'private' };

  const segments: SourceSegment[] = [];
  const ranges: Range[] = [];
  let current: { block: Element | null; range: Range } | null = null;

  const flush = () => {
    if (!current) return;
    const text = current.range.toString().replace(/\r\n/g, '\n').trim();
    if (text) {
      segments.push({ id: `s${segments.length + 1}`, text });
      ranges.push(current.range.cloneRange());
    }
    current = null;
  };

  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let node = (root.nodeType === Node.TEXT_NODE ? root : walker.nextNode()) as Text | null;
  while (node) {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;
    if (end <= start) {
      node = walker.nextNode() as Text | null;
      continue;
    }

    const block = node.parentElement?.closest(BLOCK_SELECTOR) ?? null;
    if (!current || current.block !== block) {
      flush();
      current = { block, range: document.createRange() };
      current.range.setStart(node, start);
    }
    current.range.setEnd(node, end);
    node = walker.nextNode() as Text | null;
  }
  flush();

  if (!segments.length) return { rejection: 'empty' };
  if (segments.length > MAX_SELECTION_SEGMENTS) return { rejection: 'too-many-segments' };
  const text = segments.map((segment) => segment.text).join('\n\n');
  if (text.length > MAX_SELECTION_CHARACTERS) return { rejection: 'too-long' };

  return { snapshot: { text, segments, ranges } };
}

export function highlightSourceRange(range: Range): () => void {
  const element = asElement(range.startContainer);
  const scrollTarget = element?.closest(BLOCK_SELECTOR) ?? element;
  scrollTarget?.scrollIntoView({
    block: 'center',
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });

  const HighlightConstructor = (window as unknown as {
    Highlight?: new (...ranges: Range[]) => unknown;
  }).Highlight;
  const registry = (globalThis.CSS as unknown as {
    highlights?: { set: (name: string, highlight: unknown) => void; delete: (name: string) => void };
  }).highlights;

  if (HighlightConstructor && registry) {
    const name = 'page-pup-evidence';
    const style = document.createElement('style');
    style.textContent = '::highlight(page-pup-evidence) { background-color: #f2d39b; color: inherit; }';
    document.head.appendChild(style);
    registry.set(name, new HighlightConstructor(range.cloneRange()));
    return () => {
      registry.delete(name);
      style.remove();
    };
  }

  const animation = scrollTarget?.animate(
    [{ backgroundColor: '#f2d39b' }, { backgroundColor: 'transparent' }],
    { duration: 1800, easing: 'ease-out' },
  );
  return () => animation?.cancel();
}
