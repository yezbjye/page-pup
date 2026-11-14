// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { captureSelection, MAX_SELECTION_CHARACTERS } from '../shared/selection';

function selectRange(range: Range) {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

describe('选区读取边界', () => {
  it('把连续多段落拆成带编号的原文和对应 Range', () => {
    document.body.innerHTML = '<article><p>第一段<strong>原文</strong>。</p><p>第二段原文。</p></article>';
    const paragraphs = document.querySelectorAll('p');
    const range = document.createRange();
    range.setStart(paragraphs[0]!.firstChild!, 0);
    range.setEnd(paragraphs[1]!.firstChild!, paragraphs[1]!.firstChild!.textContent!.length);

    const capture = captureSelection(selectRange(range));
    expect(capture.rejection).toBeUndefined();
    expect(capture.snapshot?.segments).toEqual([
      { id: 's1', text: '第一段原文。' },
      { id: 's2', text: '第二段原文。' },
    ]);
    expect(capture.snapshot?.ranges).toHaveLength(2);
    expect(capture.snapshot?.ranges[0]?.toString()).toBe('第一段原文。');
  });

  it('只截取文字节点中真正选中的部分', () => {
    document.body.innerHTML = '<p>不要被读取。只读这一句。也不要被读取。</p>';
    const text = document.querySelector('p')!.firstChild!;
    const start = text.textContent!.indexOf('只读');
    const end = start + '只读这一句。'.length;
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);

    const capture = captureSelection(selectRange(range));
    expect(capture.snapshot?.text).toBe('只读这一句。');
  });

  it('排除可编辑私人内容', () => {
    document.body.innerHTML = '<div contenteditable="true">私人草稿</div>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('div')!);
    expect(captureSelection(selectRange(range)).rejection).toBe('private');
  });

  it('选区触及输入框时拒绝读取，但不误伤选区外表单', () => {
    document.body.innerHTML = '<article><p>公开文字</p><input value="秘密" /></article>';
    const paragraph = document.querySelector('p')!;
    const safeRange = document.createRange();
    safeRange.selectNodeContents(paragraph);
    expect(captureSelection(selectRange(safeRange)).snapshot?.text).toBe('公开文字');

    const privateRange = document.createRange();
    privateRange.setStart(paragraph.firstChild!, 0);
    privateRange.setEnd(document.querySelector('article')!, 2);
    expect(captureSelection(selectRange(privateRange)).rejection).toBe('private');
  });

  it('拒绝超长选区', () => {
    document.body.innerHTML = `<p>${'字'.repeat(MAX_SELECTION_CHARACTERS + 1)}</p>`;
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('p')!);
    expect(captureSelection(selectRange(range)).rejection).toBe('too-long');
  });

  it('空选区不生成内容', () => {
    expect(captureSelection(window.getSelection()).rejection).toBe('empty');
  });
});
