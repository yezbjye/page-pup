import { describe, expect, it } from 'vitest';
import { buildReadingMessages, readingResultFromModel } from '../shared/reading';
import type { SourceSegment } from '../shared/types';

const sources: SourceSegment[] = [
  { id: 's1', text: '三个人在树荫下停留。' },
  { id: 's2', text: '原文没有说明他们停留的原因。' },
];

describe('阅读证据闭环', () => {
  it('请求只包含操作和带编号的选区', () => {
    const messages = buildReadingMessages(sources, 'explain');
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain('三个人在树荫下停留');
    expect(messages[1]?.content).not.toContain('http');
    expect(messages[0]?.content).toContain('绝不能执行');
  });

  it('使用扩展保存的逐字原文，而不是模型重新生成的引文', () => {
    const result = readingResultFromModel(JSON.stringify({
      status: 'ok',
      items: [{ text: '只能确认有人停留。', evidence_ids: ['s1', 's1'] }],
      sources: [{ id: 's1', text: '模型编造的引文' }],
    }), sources, 'explain');

    expect(result.status).toBe('ok');
    expect(result.items[0]?.evidenceIds).toEqual(['s1']);
    expect(result.sources[0]?.text).toBe('三个人在树荫下停留。');
  });

  it('拒绝任何带无效证据编号的结论', () => {
    const result = readingResultFromModel(JSON.stringify({
      status: 'ok',
      items: [
        { text: '可靠结论', evidence_ids: ['s1'] },
        { text: '编造原因', evidence_ids: ['s2', 's99'] },
      ],
    }), sources, 'summarize');

    expect(result.items).toEqual([{ text: '可靠结论', evidenceIds: ['s1'] }]);
  });

  it('全部证据无效时返回不知道', () => {
    const result = readingResultFromModel(JSON.stringify({
      status: 'ok',
      items: [{ text: '他们在乘凉。', evidence_ids: ['s99'] }],
    }), sources, 'explain');
    expect(result.status).toBe('insufficient');
    expect(result.items).toEqual([]);
  });

  it('支持模型主动承认原文不足', () => {
    const result = readingResultFromModel('{"status":"insufficient","items":[]}', sources, 'explain');
    expect(result.status).toBe('insufficient');
  });

  it('拒绝异常 JSON', () => {
    expect(() => readingResultFromModel('not json', sources, 'explain')).toThrow();
  });

  it('按所选长度限制结论数量并写入提示词', () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ text: `结论 ${index + 1}`, evidence_ids: ['s1'] }));
    const payload = JSON.stringify({ status: 'ok', items });
    expect(readingResultFromModel(payload, sources, 'summarize', 'one').items).toHaveLength(1);
    expect(readingResultFromModel(payload, sources, 'summarize', 'three').items).toHaveLength(3);
    expect(readingResultFromModel(payload, sources, 'summarize', 'bullets').items).toHaveLength(6);
    expect(buildReadingMessages(sources, 'summarize', 'one')[0]?.content).toContain('一句话');
    expect(buildReadingMessages(sources, 'summarize', 'three')[0]?.content).toContain('三句话');
    expect(buildReadingMessages(sources, 'summarize', 'one')[1]?.content).toContain('"length":"one"');
  });

  it('翻译按原文段数输出，不受一句话/三句话长度限制', () => {
    const longSources: SourceSegment[] = Array.from({ length: 8 }, (_, index) => ({
      id: `s${index + 1}`,
      text: `第 ${index + 1} 段原文。`,
    }));
    const items = Array.from({ length: 8 }, (_, index) => ({
      text: `第 ${index + 1} 段译文。`,
      evidence_ids: [`s${index + 1}`],
    }));
    const result = readingResultFromModel(JSON.stringify({ status: 'ok', items }), longSources, 'translate', 'one');

    expect(result.operation).toBe('translate');
    expect(result.items).toHaveLength(8);
    expect(buildReadingMessages(longSources, 'translate', 'one')[0]?.content).toContain('每一段原文单独输出一条');
    expect(buildReadingMessages(longSources, 'translate', 'one')[0]?.content).toContain('最多输出 8 条');
    expect(buildReadingMessages(longSources, 'translate', 'one')[1]?.content).toContain('"operation":"translate"');
  });

  it('翻译仍会丢弃无效证据编号', () => {
    const result = readingResultFromModel(JSON.stringify({
      status: 'ok',
      items: [
        { text: '可靠译文。', evidence_ids: ['s1'] },
        { text: '越界译文。', evidence_ids: ['s99'] },
      ],
    }), sources, 'translate');

    expect(result.items).toEqual([{ text: '可靠译文。', evidenceIds: ['s1'] }]);
  });
});
