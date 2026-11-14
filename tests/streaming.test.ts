import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestChatCompletionStream, requestReadingStream } from '../shared/llm';
import { draftItemsFromStream } from '../shared/reading';

const settings = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'user-owned-test-key',
  model: 'test-model',
};
const sources = [{ id: 's1', text: '三个人在树荫下停留。' }];

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

function sseChunksFor(content: string, pieceLength = 6): string[] {
  const encoder = new TextEncoder();
  // 按 UTF-8 字节数切成小块，模拟真实的逐段推送。
  const pieces: string[] = [];
  let buffer = '';
  for (const char of content) {
    buffer += char;
    if (encoder.encode(buffer).length >= pieceLength) {
      pieces.push(buffer);
      buffer = '';
    }
  }
  if (buffer) pieces.push(buffer);
  return [
    ...pieces.map((piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`),
    'data: [DONE]\n\n',
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('流式模型请求', () => {
  it('逐段回调 delta 并返回完整内容', async () => {
    const content = '{"status":"ok","items":[{"text":"有人在树荫下停留。","evidence_ids":["s1"]}]}';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(sseChunksFor(content))));
    const deltas: string[] = [];
    const accumulated = await requestChatCompletionStream(
      settings,
      [{ role: 'user', content: '阅读' }],
      new AbortController().signal,
      1200,
      30,
      (text) => deltas.push(text),
    );
    expect(accumulated).toBe(content);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(content);
  });

  it('请求体带 stream: true 且保持 json_object 协议', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(sseChunksFor('{"status":"insufficient","items":[]}')));
    vi.stubGlobal('fetch', fetchMock);
    await requestChatCompletionStream(settings, [], new AbortController().signal, 1200, 30, () => undefined);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toMatchObject({ stream: true, response_format: { type: 'json_object' } });
  });

  it('requestReadingStream 在流结束后解析出带证据的正式结果', async () => {
    const content = '{"status":"ok","items":[{"text":"有人停留。","evidence_ids":["s1"]}]}';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(sseChunksFor(content))));
    const result = await requestReadingStream(
      settings,
      sources,
      'explain',
      new AbortController().signal,
      'bullets',
      30,
      () => undefined,
    );
    expect(result.status).toBe('ok');
    expect(result.items[0]?.evidenceIds).toEqual(['s1']);
    expect(result.sources[0]?.text).toBe('三个人在树荫下停留。');
  });

  it('网关不支持流式响应体时退回一次性 JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      json: async () => ({ choices: [{ message: { content: '{"status":"insufficient","items":[]}' } }] }),
    } as unknown as Response));
    const deltas: string[] = [];
    const accumulated = await requestChatCompletionStream(
      settings,
      [],
      new AbortController().signal,
      1200,
      30,
      (text) => deltas.push(text),
    );
    expect(accumulated).toBe('{"status":"insufficient","items":[]}');
    expect(deltas).toEqual([accumulated]);
  });

  it.each([
    ['timeout', 'TIMEOUT', '请求超过 30 秒'],
    ['cancelled', 'ABORTED', '已取消本次阅读'],
  ] as const)('中止信号 %s 映射为 %s', async (reason, code, messagePart) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init: RequestInit) => new Promise<never>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const controller = new AbortController();
    const request = requestChatCompletionStream(settings, [], controller.signal, 1200, 30, () => undefined);
    controller.abort(reason);
    await expect(request).rejects.toMatchObject({ code, message: expect.stringContaining(messagePart) });
  });

  it('流式输出为空时报告模型没有返回内容', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(['data: {"choices":[{"delta":{}}]}\n\n', 'data: [DONE]\n\n'])));
    await expect(requestChatCompletionStream(
      settings,
      [],
      new AbortController().signal,
      1200,
      30,
      () => undefined,
    )).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});

describe('流式草稿提取', () => {
  it('从半成品 JSON 中抽出正在生成的结论', () => {
    const partial = '{"status":"ok","items":[{"text":"有人在树荫下';
    expect(draftItemsFromStream(partial)).toEqual(['有人在树荫下']);
  });

  it('多条结论按顺序输出，未闭合的最后一条也展示', () => {
    const partial = '{"status":"ok","items":[{"text":"第一条结论","evidence_ids":["s1"]},{"text":"第二条正在写';
    expect(draftItemsFromStream(partial)).toEqual(['第一条结论', '第二条正在写']);
  });

  it('还原转义字符，转义符写一半时先等下一批', () => {
    expect(draftItemsFromStream('{"text":"第一行\\n第二行"}')).toEqual(['第一行\n第二行']);
    const withEscaped = '{"items":[{"text":"引号\\"和\\\\斜杠"}]}';
    expect(draftItemsFromStream(withEscaped)).toEqual(['引号"和\\斜杠']);
    const partialEscape = '{"items":[{"text":"换行\\';
    expect(draftItemsFromStream(partialEscape)).toEqual(['换行']);
  });

  it('支持 \\u 转义，码点没写完整时等下一批', () => {
    expect(draftItemsFromStream('{"items":[{"text":"\\u57ce\\u5e02"}]}')).toEqual(['城市']);
    expect(draftItemsFromStream('{"items":[{"text":"\\u57c')).toEqual([]);
  });

  it('还没有任何 text 字段时返回空数组', () => {
    expect(draftItemsFromStream('{"status":"ok","item')).toEqual([]);
    expect(draftItemsFromStream('')).toEqual([]);
  });
});
