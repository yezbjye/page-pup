import { describe, expect, it } from 'vitest';
import { createSseParser, deltaTextFromSseData } from '../shared/sse';

function sse(...lines: string[]): string {
  // 真实 SSE 的事件行都以换行结束。
  return `${lines.join('\n')}\n`;
}

describe('SSE 解析', () => {
  it('按行拆分 data 事件，支持多个事件在同一个数据块', () => {
    const parser = createSseParser();
    const events = parser.push(sse(
      'data: {"choices":[{"delta":{"content":"你"}}]}',
      'data: {"choices":[{"delta":{"content":"好"}}]}',
      '',
    ));
    expect(events).toEqual([
      { data: '{"choices":[{"delta":{"content":"你"}}]}' },
      { data: '{"choices":[{"delta":{"content":"好"}}]}' },
    ]);
  });

  it('跨数据块被截断的行会先缓冲，等下一块补齐', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"choices":[{"delta":{"content":"流')).toEqual([]);
    const events = parser.push('"}}]}\n\n');
    expect(events).toEqual([{ data: '{"choices":[{"delta":{"content":"流"}}]}' }]);
  });

  it('兼容 CRLF 与 data: 后无空格的网关', () => {
    const parser = createSseParser();
    const events = parser.push('data:{"choices":[]}\r\n\r\n');
    expect(events).toEqual([{ data: '{"choices":[]}' }]);
  });

  it('忽略注释行、event 行和空 data 行', () => {
    const parser = createSseParser();
    const events = parser.push(sse(
      ': keep-alive',
      'event: delta',
      'data: ',
      'data: {"choices":[]}',
    ));
    expect(events).toEqual([{ data: '{"choices":[]}' }]);
  });

  it('识别 [DONE] 结束标记', () => {
    const parser = createSseParser();
    const events = parser.push(sse(
      'data: {"choices":[]}',
      'data: [DONE]',
    ));
    expect(events).toEqual([{ data: '{"choices":[]}' }, { done: true }]);
  });
});

describe('SSE 增量提取', () => {
  it('提取 choices[0].delta.content', () => {
    expect(deltaTextFromSseData('{"choices":[{"delta":{"content":"逐字"}}]}')).toBe('逐字');
  });

  it('没有增量内容时返回空串', () => {
    expect(deltaTextFromSseData('{"choices":[{"delta":{}}]}')).toBe('');
    expect(deltaTextFromSseData('{"choices":[{"finish_reason":"stop"}]}')).toBe('');
    expect(deltaTextFromSseData('{}')).toBe('');
  });

  it('非 JSON 载荷静默忽略', () => {
    expect(deltaTextFromSseData('internal error')).toBe('');
  });
});
