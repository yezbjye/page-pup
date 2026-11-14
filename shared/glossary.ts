/**
 * 本地术语本：只保存术语与释义摘要，sourceOrigin 只存站点 origin，不保存完整网址。
 * 上限 500 条，超出时自动淘汰最旧的条目。
 */
export const GLOSSARY_KEY = 'pagePup.glossary';
export const GLOSSARY_MAX_ENTRIES = 500;
export const GLOSSARY_TERM_MAX_LENGTH = 60;
export const GLOSSARY_DEFINITION_MAX_LENGTH = 140;

export interface GlossaryEntry {
  id: string;
  term: string;
  definition: string;
  sourceOrigin?: string;
  createdAt: number;
}

export interface GlossaryInput {
  term: string;
  definition: string;
  sourceOrigin?: string;
}

let idCounter = 0;
// 单调递增的收录时间戳：同一毫秒内的多次收录也能稳定保持「后收的更新」。
let monotonicStamp = 0;

function newId(): string {
  // jsdom 等测试环境可能没有 crypto.randomUUID，做一层兜底。
  const random = (globalThis.crypto as Crypto | undefined)?.randomUUID;
  if (typeof random === 'function') return random.call(globalThis.crypto);
  idCounter += 1;
  return `glossary-${Date.now()}-${idCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

function storageArea(): chrome.storage.LocalStorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('chrome.storage.local 不可用');
  }
  return chrome.storage.local;
}

export function normalizeGlossaryTerm(term: string): string {
  return term.replace(/\s+/g, ' ').trim().slice(0, GLOSSARY_TERM_MAX_LENGTH);
}

export async function getGlossary(): Promise<GlossaryEntry[]> {
  const result = await storageArea().get(GLOSSARY_KEY);
  const stored = result[GLOSSARY_KEY];
  return Array.isArray(stored) ? stored as GlossaryEntry[] : [];
}

/**
 * 批量收录术语：相同术语会更新释义并把条目挪到最新，超上限时淘汰最旧的。
 * 返回保存后的完整列表（新条目在前）。
 */
export async function saveGlossaryEntries(inputs: GlossaryInput[]): Promise<GlossaryEntry[]> {
  const current = await getGlossary();
  const byTerm = new Map(current.map((entry) => [entry.term, entry] as const));
  const base = Date.now();
  const valid = inputs
    .map((input) => ({
      term: normalizeGlossaryTerm(input.term),
      definition: input.definition.trim().slice(0, GLOSSARY_DEFINITION_MAX_LENGTH),
      sourceOrigin: input.sourceOrigin,
    }))
    .filter((input) => input.term && input.definition);
  if (valid.length) {
    // 同一批内先提交的展示在前，之后批次一定比之前的所有条目都新。
    const batchBase = Math.max(base, monotonicStamp + 1);
    monotonicStamp = batchBase + valid.length - 1;
    valid.forEach((input, index) => {
      const createdAt = batchBase + (valid.length - 1 - index);
      const existing = byTerm.get(input.term);
      if (existing) {
        byTerm.set(input.term, {
          ...existing,
          definition: input.definition,
          sourceOrigin: input.sourceOrigin ?? existing.sourceOrigin,
          createdAt,
        });
      } else {
        byTerm.set(input.term, {
          id: newId(),
          term: input.term,
          definition: input.definition,
          ...(input.sourceOrigin ? { sourceOrigin: input.sourceOrigin } : {}),
          createdAt,
        });
      }
    });
  }

  const merged = Array.from(byTerm.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, GLOSSARY_MAX_ENTRIES); // 新条目在前，截断时留下最新 500 条。
  await storageArea().set({ [GLOSSARY_KEY]: merged });
  return merged;
}

export async function deleteGlossaryEntry(id: string): Promise<GlossaryEntry[]> {
  const next = (await getGlossary()).filter((entry) => entry.id !== id);
  await storageArea().set({ [GLOSSARY_KEY]: next });
  return next;
}

export async function clearGlossary(): Promise<void> {
  await storageArea().set({ [GLOSSARY_KEY]: [] });
}

export interface TermHit {
  term: string;
  index: number;
  length: number;
}

function isWordChar(char: string): boolean {
  return char >= '0' && char <= '9' || char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z';
}

/**
 * 在文本中查找命中的术语。长术语优先，同一位置只保留最长命中；
 * 拉丁术语要求前后不是字母数字，避免 cat 命中 category。
 */
export function findTermsInText(text: string, terms: string[]): TermHit[] {
  const unique = Array.from(new Set(terms.map((term) => term.trim()).filter(Boolean)));
  if (!unique.length || !text) return [];
  unique.sort((a, b) => b.length - a.length);

  const occupied = new Array<boolean>(text.length).fill(false);
  const hits: TermHit[] = [];
  for (const term of unique) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(term, from);
      if (index === -1) break;
      from = index + 1;
      const end = index + term.length;
      if (occupied.slice(index, end).some(Boolean)) continue; // 已被更长术语占用。
      if (isWordChar(term[0]!) && index > 0 && isWordChar(text[index - 1]!)) continue;
      if (isWordChar(term[term.length - 1]!) && end < text.length && isWordChar(text[end]!)) continue;
      for (let i = index; i < end; i += 1) occupied[i] = true;
      hits.push({ term, index, length: term.length });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}
