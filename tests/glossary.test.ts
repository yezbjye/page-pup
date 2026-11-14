import { afterEach, describe, expect, it } from 'vitest';
import {
  clearGlossary,
  deleteGlossaryEntry,
  findTermsInText,
  getGlossary,
  GLOSSARY_MAX_ENTRIES,
  GLOSSARY_TERM_MAX_LENGTH,
  normalizeGlossaryTerm,
  saveGlossaryEntries,
} from '../shared/glossary';

function installStorageMock(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        async get(key: string) {
          return store.has(key) ? { [key]: store.get(key) } : {};
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) store.set(key, value);
        },
      },
    },
  };
  return store;
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('findTermsInText', () => {
  it('命中中文术语并按出现位置返回', () => {
    const hits = findTermsInText('城市漫步的关键是城市漫步的心态。', ['城市漫步']);
    expect(hits).toEqual([
      { term: '城市漫步', index: 0, length: 4 },
      { term: '城市漫步', index: 8, length: 4 },
    ]);
  });

  it('长术语优先，重叠时只保留最长命中', () => {
    const hits = findTermsInText('理解 React Hooks 的规则', ['React', 'React Hooks', 'Hooks']);
    expect(hits).toEqual([{ term: 'React Hooks', index: 3, length: 11 }]);
  });

  it('拉丁术语不允许命中在更长的单词内部', () => {
    expect(findTermsInText('category 里没有 cat', ['cat'])).toEqual([{ term: 'cat', index: 13, length: 3 }]);
    expect(findTermsInText('categorize', ['cat'])).toEqual([]);
  });

  it('忽略空术语与重复术语', () => {
    expect(findTermsInText('任意文字', ['', '  ', '任意'])).toEqual([{ term: '任意', index: 0, length: 2 }]);
  });

  it('命中不会互相重叠', () => {
    const hits = findTermsInText('abcabc', ['abc', 'abcabc']);
    expect(hits).toEqual([{ term: 'abcabc', index: 0, length: 6 }]);
  });

  it('相邻但不重叠的术语都可以命中', () => {
    const hits = findTermsInText('abc abcdef', ['abc', 'abcdef']);
    expect(hits).toEqual([
      { term: 'abc', index: 0, length: 3 },
      { term: 'abcdef', index: 4, length: 6 },
    ]);
  });

  it('空文本或没有术语时返回空数组', () => {
    expect(findTermsInText('', ['术语'])).toEqual([]);
    expect(findTermsInText('文本', [])).toEqual([]);
  });
});

describe('术语本存储', () => {
  it('收录会规范术语长度并只保留 140 字释义', async () => {
    installStorageMock();
    const longTerm = '术'.repeat(100);
    const longDefinition = '释'.repeat(200);
    const saved = await saveGlossaryEntries([{ term: longTerm, definition: longDefinition, sourceOrigin: 'https://a.example.com' }]);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.term).toHaveLength(GLOSSARY_TERM_MAX_LENGTH);
    expect(saved[0]!.definition).toHaveLength(140);
    expect(saved[0]!.sourceOrigin).toBe('https://a.example.com');
    expect(saved[0]!.id).toBeTruthy();
    expect(await getGlossary()).toEqual(saved);
  });

  it('相同术语再收录会更新释义而不是新增', async () => {
    installStorageMock();
    await saveGlossaryEntries([{ term: '城市漫步', definition: '旧释义' }]);
    const saved = await saveGlossaryEntries([{ term: '城市漫步', definition: '新释义' }]);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.definition).toBe('新释义');
  });

  it('超过 500 条时淘汰最旧的条目', async () => {
    installStorageMock();
    const first = await saveGlossaryEntries(Array.from({ length: GLOSSARY_MAX_ENTRIES }, (_, index) => ({
      term: `术语${index}`,
      definition: `释义${index}`,
    })));
    expect(first).toHaveLength(GLOSSARY_MAX_ENTRIES);
    // 再补 3 条，最旧的 术语497/术语498/术语499 应被淘汰。
    const next = await saveGlossaryEntries([
      { term: '新术语甲', definition: '甲释义' },
      { term: '新术语乙', definition: '乙释义' },
      { term: '新术语丙', definition: '丙释义' },
    ]);
    expect(next).toHaveLength(GLOSSARY_MAX_ENTRIES);
    const terms = new Set(next.map((entry) => entry.term));
    expect(terms.has('术语497')).toBe(false);
    expect(terms.has('术语499')).toBe(false);
    expect(terms.has('术语0')).toBe(true);
    expect(terms.has('术语496')).toBe(true);
    expect(terms.has('新术语甲')).toBe(true);
    expect(terms.has('新术语丙')).toBe(true);
  });

  it('单批收录保持提交顺序，新条目排在前面', async () => {
    installStorageMock();
    const saved = await saveGlossaryEntries([
      { term: '第一条', definition: '1' },
      { term: '第二条', definition: '2' },
    ]);
    expect(saved.map((entry) => entry.term)).toEqual(['第一条', '第二条']);
  });

  it('删除与清空只影响术语本键', async () => {
    const store = installStorageMock();
    const saved = await saveGlossaryEntries([{ term: '可删除', definition: '释义' }]);
    const afterDelete = await deleteGlossaryEntry(saved[0]!.id);
    expect(afterDelete).toEqual([]);
    await saveGlossaryEntries([{ term: '再来一条', definition: '释义' }]);
    await clearGlossary();
    expect(await getGlossary()).toEqual([]);
    expect(store.has('pagePup.glossary')).toBe(true);
  });

  it('normalizeGlossaryTerm 折叠空白并截断', () => {
    expect(normalizeGlossaryTerm('  城市 \n 漫步  ')).toBe('城市 漫步');
    expect(normalizeGlossaryTerm('x'.repeat(80))).toHaveLength(GLOSSARY_TERM_MAX_LENGTH);
  });
});
