import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeBaseUrl, requestChatCompletion } from '../shared/llm';
import { buildReadingMessages } from '../shared/reading';

const settings = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'user-owned-test-key',
  model: 'test-model',
};
const messages = buildReadingMessages([{ id: 's1', text: '只读这一句原文。' }], 'explain');

function mockFetch(response: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('模型请求边界与错误处理', () => {
  it('没有用户 Key 时不发起网络请求', async () => {
    const fetchMock = mockFetch({});
    await expect(requestChatCompletion(
      { ...settings, apiKey: '  ' },
      messages,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'NO_KEY' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('没有模型名称时不发起网络请求', async () => {
    const fetchMock = mockFetch({});
    await expect(requestChatCompletion(
      { ...settings, model: '  ' },
      messages,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('拒绝非本机的 HTTP API 地址', async () => {
    const fetchMock = mockFetch({});
    await expect(requestChatCompletion(
      { ...settings, baseUrl: 'http://api.example.com/v1' },
      messages,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('允许本机 HTTP 并移除末尾斜杠', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1');
  });

  it('兼容已经包含 /chat/completions 的地址，避免重复拼接', () => {
    expect(normalizeBaseUrl('https://maas.example.com/compatible-mode/v1/chat/completions'))
      .toBe('https://maas.example.com/compatible-mode/v1');
    expect(normalizeBaseUrl('https://maas.example.com/compatible-mode/v1/chat/completions/'))
      .toBe('https://maas.example.com/compatible-mode/v1');
  });

  it('只向规范的兼容接口发送当前配置和消息', async () => {
    const fetchMock = mockFetch({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"status":"insufficient","items":[]}' } }] }),
    });
    await requestChatCompletion(settings, messages, new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer user-owned-test-key',
        },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body);
    expect(body).toMatchObject({ model: 'test-model', messages, temperature: 0.1 });
  });

  it.each([401, 403])('把 HTTP %i 归为 Key 或权限错误', async (status) => {
    mockFetch({ ok: false, status });
    await expect(requestChatCompletion(
      settings,
      messages,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('把 HTTP 429 归为限流或额度错误', async () => {
    mockFetch({ ok: false, status: 429 });
    await expect(requestChatCompletion(
      settings,
      messages,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('拒绝模型接口的异常 JSON', async () => {
    mockFetch({ ok: true, json: async () => { throw new SyntaxError('bad json'); } });
    await expect(requestChatCompletion(
      settings,
      messages,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('拒绝缺少可读取内容的响应', async () => {
    mockFetch({ ok: true, json: async () => ({ choices: [] }) });
    await expect(requestChatCompletion(
      settings,
      messages,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('把连接失败归为网络错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection failed')));
    await expect(requestChatCompletion(
      settings,
      messages,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it.each([
    ['timeout', 'TIMEOUT'],
    ['cancelled', 'ABORTED'],
  ] as const)('区分超时和用户取消：%s', async (reason, code) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init: RequestInit) => (
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })
    )));
    const controller = new AbortController();
    const request = requestChatCompletion(settings, messages, controller.signal);
    controller.abort(reason);
    await expect(request).rejects.toMatchObject({ code });
  });
});
