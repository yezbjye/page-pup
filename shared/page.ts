import type { SourceSegment } from './types';

const BLOCK_SELECTOR = 'h1, h2, h3, h4, p, li, blockquote, pre, td, th, dd, dt';
const EXCLUDED_SELECTOR = 'nav, aside, footer, header, form, script, style, noscript, template, [aria-hidden="true"], [data-page-pup-private], #page-pup-host';

export const MAX_PAGE_CHARACTERS = 4500;
export const MAX_PAGE_SEGMENTS = 6;

export interface PageSnapshot {
  title: string;
  text: string;
  segments: SourceSegment[];
}

function chunkLines(lines: string[]): SourceSegment[] {
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  const limit = Math.max(200, Math.ceil(total / MAX_PAGE_SEGMENTS));
  const segments: SourceSegment[] = [];
  let buffer = '';

  const flush = () => {
    if (!buffer.trim()) return;
    segments.push({ id: `s${segments.length + 1}`, text: buffer.trim() });
    buffer = '';
  };

  for (const line of lines) {
    if (buffer && buffer.length + line.length + 1 > limit) flush();
    buffer += `${buffer ? '\n' : ''}${line}`;
  }
  flush();
  return segments.slice(0, MAX_PAGE_SEGMENTS);
}

export function extractPageSnapshot(doc: Document = document): PageSnapshot | null {
  const root = doc.querySelector('article')
    ?? doc.querySelector('main')
    ?? doc.querySelector('[role="main"]')
    ?? doc.body;
  if (!root) return null;

  const blocks = Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter((element) => {
    if (element.closest(EXCLUDED_SELECTOR)) return false;
    if (element.querySelector(BLOCK_SELECTOR)) return false;
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    return text.length >= 8;
  });

  const lines: string[] = [];
  let total = 0;
  for (const block of blocks) {
    const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text || lines[lines.length - 1] === text) continue;
    if (total + text.length > MAX_PAGE_CHARACTERS) break;
    lines.push(text);
    total += text.length + 1;
  }

  if (lines.length < 2 || total < 60) return null;
  return {
    title: doc.title.trim(),
    text: lines.join('\n'),
    segments: chunkLines(lines),
  };
}
