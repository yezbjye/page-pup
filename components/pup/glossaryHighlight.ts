import { findTermsInText, type GlossaryEntry } from '../../shared/glossary';

/**
 * 全页术语高亮：在页面正文文本节点上包 <mark>，悬停浮出释义卡。
 * 样式只改背景与下划线颜色，不改盒模型尺寸，避免布局抖动；
 * 所有节点与样式元素都登记在案，卸载/禁用时无残留。
 */
const EXCLUDE_SELECTOR = [
  'script',
  'style',
  'noscript',
  'title',
  'textarea',
  '#page-pup-host',
  'mark[data-page-pup-glossary]',
  '[data-page-pup-glossary-tip]',
  '[contenteditable]:not([contenteditable="false"])',
].join(', ');

const MAX_MARKS_PER_PAGE = 200;
const NODES_PER_IDLE_BATCH = 24;

const PAGE_STYLES = `
mark[data-page-pup-glossary] {
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 2px;
  color: inherit;
  background-color: rgba(242, 211, 155, 0.5);
  text-decoration: underline;
  text-decoration-color: rgba(185, 104, 54, 0.45);
  text-underline-offset: 3px;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  cursor: help;
}
[data-page-pup-glossary-tip] {
  position: fixed;
  z-index: 2147483647;
  max-width: min(320px, calc(100vw - 24px));
  padding: 12px 14px;
  border: 1px solid #ded5c9;
  border-radius: 12px;
  color: #302a25;
  background: #fffdf9;
  box-shadow: 0 12px 40px rgb(58 42 27 / 18%);
  font: 12px/1.7 Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  color-scheme: only light;
}
[data-page-pup-glossary-tip] .pup-gt-term { display: block; font-size: 13px; font-weight: 650; }
[data-page-pup-glossary-tip] .pup-gt-definition { display: block; margin: 6px 0 0; color: #5f554b; }
[data-page-pup-glossary-tip] .pup-gt-origin { display: block; margin-top: 6px; color: #8a7e72; font-size: 11px; }
[data-page-pup-glossary-tip] .pup-gt-actions { display: flex; justify-content: flex-end; margin-top: 9px; }
[data-page-pup-glossary-tip] button {
  padding: 4px 9px;
  border: 1px solid #d8ccbd;
  border-radius: 7px;
  color: #8a4a24;
  background: #fffaf3;
  font-size: 11px;
  cursor: pointer;
}
[data-page-pup-glossary-tip] button:hover { border-color: #a95c2f; }
`;

export interface GlossaryHighlightOptions {
  getEntries: () => GlossaryEntry[];
  onDelete: (id: string) => void;
  /** 一次完整扫描结束后回调命中的不同术语数，用于「认识它」气泡。 */
  onScanComplete?: (uniqueTerms: number) => void;
}

export interface GlossaryHighlightController {
  refresh(): void;
  destroy(): void;
}

interface ScheduledIdle {
  cancel(): void;
}

function scheduleIdle(task: () => void): ScheduledIdle {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(task, { timeout: 500 });
    return { cancel: () => window.cancelIdleCallback(handle) };
  }
  const handle = window.setTimeout(task, 16);
  return { cancel: () => window.clearTimeout(handle) };
}

export function createGlossaryHighlight(options: GlossaryHighlightOptions): GlossaryHighlightController {
  const { getEntries, onDelete, onScanComplete } = options;

  const styleElement = document.createElement('style');
  styleElement.textContent = PAGE_STYLES;
  (document.head ?? document.documentElement).appendChild(styleElement);

  const tipElement = document.createElement('div');
  tipElement.setAttribute('data-page-pup-glossary-tip', '');
  tipElement.setAttribute('role', 'tooltip');
  tipElement.style.display = 'none';
  document.body?.appendChild(tipElement);

  let scheduled: ScheduledIdle | null = null;
  let hideTimer = 0;
  let marks: Element[] = [];
  let scanGeneration = 0;

  const hideTipSoon = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => { tipElement.style.display = 'none'; }, 180);
  };
  const cancelHideTip = () => window.clearTimeout(hideTimer);

  const onTipEnter = cancelHideTip;
  const onTipLeave = hideTipSoon;
  tipElement.addEventListener('mouseenter', onTipEnter);
  tipElement.addEventListener('mouseleave', onTipLeave);

  const showTipFor = (entry: GlossaryEntry, target: Element) => {
    cancelHideTip();
    const rect = target.getBoundingClientRect();
    tipElement.replaceChildren(
      ...[
        Object.assign(document.createElement('span'), { className: 'pup-gt-term', textContent: entry.term }),
        Object.assign(document.createElement('span'), { className: 'pup-gt-definition', textContent: entry.definition }),
        entry.sourceOrigin ? Object.assign(document.createElement('span'), { className: 'pup-gt-origin', textContent: `来自 ${entry.sourceOrigin}` }) : null,
        (() => {
          const actions = document.createElement('div');
          actions.className = 'pup-gt-actions';
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = '删除这条术语';
          remove.addEventListener('click', () => {
            tipElement.style.display = 'none';
            onDelete(entry.id);
          });
          actions.append(remove);
          return actions;
        })(),
      ].filter(Boolean) as Element[],
    );
    tipElement.style.display = 'block';
    const tipRect = tipElement.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - tipRect.width - 8);
    const belowTop = rect.bottom + 8;
    const top = belowTop + tipRect.height > window.innerHeight - 8
      ? Math.max(8, rect.top - tipRect.height - 8)
      : belowTop;
    tipElement.style.left = `${Math.round(left)}px`;
    tipElement.style.top = `${Math.round(top)}px`;
  };

  const hideOnScroll = () => { window.clearTimeout(hideTimer); tipElement.style.display = 'none'; };
  window.addEventListener('scroll', hideOnScroll, { capture: true, passive: true });

  const unwrapAll = () => {
    for (const mark of marks) {
      if (!mark.isConnected) continue;
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      mark.remove();
      parent.normalize();
    }
    marks = [];
  };

  const collectTextNodes = (): Text[] => {
    const nodes: Text[] = [];
    if (!document.body) return nodes;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = (node as Text).parentElement;
        if (!parent || parent.closest(EXCLUDE_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return (node as Text).data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let node = walker.nextNode() as Text | null;
    while (node) {
      nodes.push(node);
      node = walker.nextNode() as Text | null;
    }
    return nodes;
  };

  const wrapHit = (node: Text, hit: { index: number; length: number }, entry: GlossaryEntry) => {
    const range = document.createRange();
    range.setStart(node, hit.index);
    range.setEnd(node, hit.index + hit.length);
    const mark = document.createElement('mark');
    mark.setAttribute('data-page-pup-glossary', '');
    mark.setAttribute('data-page-pup-glossary-id', entry.id);
    const onEnter = () => showTipFor(entry, mark);
    const onLeave = hideTipSoon;
    mark.addEventListener('mouseenter', onEnter);
    mark.addEventListener('mouseleave', onLeave);
    try {
      range.surroundContents(mark);
    } catch {
      // 文本节点在扫描间隙被页面脚本改写时放弃这一处，不影响其余命中。
      return;
    }
    marks.push(mark);
  };

  const startScan = () => {
    unwrapAll();
    tipElement.style.display = 'none';
    const entries = getEntries().filter((entry) => entry.term.trim() && entry.definition.trim());
    if (!entries.length || !document.body) {
      onScanComplete?.(0);
      return;
    }
    const byTerm = new Map(entries.map((entry) => [entry.term, entry] as const));
    const terms = Array.from(byTerm.keys());
    const textNodes = collectTextNodes();
    const generation = ++scanGeneration;

    let nodeIndex = 0;
    let markCount = 0;
    const matchedTerms = new Set<string>();

    const step = () => {
      if (generation !== scanGeneration) return; // 已被新一轮 refresh 取代。
      let processed = 0;
      while (nodeIndex < textNodes.length && processed < NODES_PER_IDLE_BATCH && markCount < MAX_MARKS_PER_PAGE) {
        const node = textNodes[nodeIndex]!;
        nodeIndex += 1;
        processed += 1;
        if (!node.isConnected || !node.data) continue;
        const hits = findTermsInText(node.data, terms);
        // 倒序包裹，前面的偏移量不会被后面的拆分破坏。
        for (let i = hits.length - 1; i >= 0 && markCount < MAX_MARKS_PER_PAGE; i -= 1) {
          const hit = hits[i]!;
          const entry = byTerm.get(hit.term);
          if (!entry) continue;
          wrapHit(node, hit, entry);
          markCount += 1;
          matchedTerms.add(entry.term);
        }
      }
      if (nodeIndex < textNodes.length && markCount < MAX_MARKS_PER_PAGE) {
        scheduled = scheduleIdle(step);
      } else {
        scheduled = null;
        onScanComplete?.(matchedTerms.size);
      }
    };
    scheduled = scheduleIdle(step);
  };

  return {
    refresh: startScan,
    destroy() {
      scanGeneration += 1;
      scheduled?.cancel();
      scheduled = null;
      window.clearTimeout(hideTimer);
      window.removeEventListener('scroll', hideOnScroll, { capture: true });
      tipElement.removeEventListener('mouseenter', onTipEnter);
      tipElement.removeEventListener('mouseleave', onTipLeave);
      tipElement.style.display = 'none';
      unwrapAll();
      tipElement.remove();
      styleElement.remove();
    },
  };
}
