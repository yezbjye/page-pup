// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { extractPageSnapshot, MAX_PAGE_CHARACTERS } from '../shared/page';
import { MAX_SELECTION_SEGMENTS } from '../shared/selection';

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('整页总结的读取边界', () => {
  it('读取正文段落并忽略导航、表单和隐私区域', () => {
    document.title = '城市漫步观察笔记';
    document.body.innerHTML = `
      <nav>首页 目录 关于我们</nav>
      <article>
        <h1>城市漫步观察笔记</h1>
        <p>城市漫步并不是简单地走得慢，而是把一部分注意力从目的地挪回沿途。</p>
        <p>记录时，可以先写下亲眼看到的事实，再补充自己的解释。</p>
        <form><p>这段表单说明不应该被读取进来。</p></form>
        <aside><p>这段侧边栏推广不应该被读取进来。</p></aside>
        <p data-page-pup-private>这段隐私区域不应该被读取进来。</p>
      </article>
    `;

    const page = extractPageSnapshot(document);
    expect(page).not.toBeNull();
    expect(page?.title).toBe('城市漫步观察笔记');
    expect(page?.segments.length).toBeGreaterThan(0);
    expect(page?.segments[0]?.id).toBe('s1');
    expect(page?.text).toContain('把一部分注意力从目的地挪回沿途');
    expect(page?.text).not.toContain('首页');
    expect(page?.text).not.toContain('表单说明');
    expect(page?.text).not.toContain('侧边栏');
    expect(page?.text).not.toContain('隐私区域');
  });

  it('控制整页正文长度和分段数量，避免超出阅读协议', () => {
    const paragraph = '这是一段用于验证整页总结边界的正文。'.repeat(40);
    document.body.innerHTML = `<article>${Array.from({ length: 30 }, (_, index) => `<p>第 ${index + 1} 段。${paragraph}</p>`).join('')}</article>`;

    const page = extractPageSnapshot(document);
    expect(page).not.toBeNull();
    const segments = page!.segments;
    expect(segments.length).toBeLessThanOrEqual(MAX_SELECTION_SEGMENTS);
    expect(segments.map((segment) => segment.id)).toEqual(segments.map((_, index) => `s${index + 1}`));
    const total = segments.reduce((sum, segment) => sum + segment.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_PAGE_CHARACTERS);
  });

  it('正文太少时不生成整页总结', () => {
    document.body.innerHTML = '<article><p>短。</p></article>';
    expect(extractPageSnapshot(document)).toBeNull();
  });
});
