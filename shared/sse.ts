/**
 * 解析 OpenAI 兼容接口的 SSE 流（server-sent events）。
 * 只关心 data: 行，其余 event:/id:/注释行按规范忽略。
 */
export type SseEvent = { data: string } | { done: true };

export function createSseParser(): { push(chunk: string): SseEvent[] } {
  let buffer = '';
  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk;
      const events: SseEvent[] = [];
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.startsWith(':')) continue; // 心跳注释行。
        if (!line.startsWith('data:')) continue; // event:/id:/空行都不需要。
        // SSE 规范只去掉 data: 后的一个空格，这里兼容多空格网关。
        const data = line.slice(5).replace(/^ +/, '');
        if (!data) continue;
        if (data === '[DONE]') {
          events.push({ done: true });
        } else {
          events.push({ data });
        }
      }
      return events;
    },
  };
}

/**
 * 从一条 data 载荷中提取增量文本 choices[0].delta.content。
 * 解析失败或没有增量内容时返回空串，调用方直接忽略即可，
 * 因为部分网关会夹带 usage/keep-alive 之类的非内容块。
 */
export function deltaTextFromSseData(data: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return '';
  }
  const delta = (payload as {
    choices?: Array<{ delta?: { content?: unknown } }>;
  })?.choices?.[0]?.delta?.content;
  return typeof delta === 'string' ? delta : '';
}
