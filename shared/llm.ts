import { buildReadingMessages, readingResultFromModel } from './reading';
import { createSseParser, deltaTextFromSseData } from './sse';
import type { PupSettings, ReadingLength, ReadingOperation, ReadingResult, SourceSegment } from './types';

export type LlmErrorCode = 'NO_KEY' | 'INVALID_CONFIG' | 'API_PERMISSION' | 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'ABORTED' | 'NETWORK' | 'BAD_RESPONSE' | 'HTTP';

export class LlmError extends Error {
  constructor(message: string, public readonly code: LlmErrorCode) {
    super(message);
    this.name = 'LlmError';
  }
}

type ChatMessage = ReturnType<typeof buildReadingMessages>[number];

export function normalizeBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new LlmError('请输入完整、有效的 API 地址', 'INVALID_CONFIG');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new LlmError('API 地址必须使用 HTTPS，本机测试可使用 HTTP', 'INVALID_CONFIG');
  }
  const normalized = baseUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return normalized.replace(/\/+$/, '');
}

function normalizedEndpoint(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

function contentFromResponse(payload: unknown): string {
  const content = (payload as {
    choices?: Array<{ message?: { content?: unknown } }>;
  })?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.map((part) => {
      if (!part || typeof part !== 'object') return '';
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : '';
    }).join('');
    if (text) return text;
  }
  throw new LlmError('模型没有返回可读取的内容', 'BAD_RESPONSE');
}

export async function requestChatCompletion(
  settings: Pick<PupSettings, 'baseUrl' | 'apiKey' | 'model'>,
  messages: ChatMessage[],
  signal: AbortSignal,
  maxTokens = 1200,
  timeoutSeconds = 30,
): Promise<string> {
  if (!settings.apiKey.trim()) throw new LlmError('请先在设置页填写 API Key', 'NO_KEY');
  if (!settings.model.trim()) throw new LlmError('请先填写模型名称', 'INVALID_CONFIG');
  const endpoint = normalizedEndpoint(settings.baseUrl);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: settings.model.trim(),
        messages,
        temperature: 0.1,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      if (signal.reason === 'timeout') throw new LlmError(`请求超过 ${timeoutSeconds} 秒，已自动停止`, 'TIMEOUT');
      throw new LlmError('已取消本次阅读', 'ABORTED');
    }
    throw new LlmError(error instanceof Error ? `无法连接模型：${error.message}` : '无法连接模型', 'NETWORK');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new LlmError('API Key 无效或没有访问权限', 'AUTH');
    if (response.status === 429) throw new LlmError('模型请求过于频繁或额度不足，请稍后再试', 'RATE_LIMIT');
    if (response.status === 404) throw new LlmError('模型接口返回 HTTP 404，请检查 API 地址和模型名称是否正确', 'HTTP');
    throw new LlmError(`模型接口返回 HTTP ${response.status}`, 'HTTP');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new LlmError('模型接口返回了异常 JSON', 'BAD_RESPONSE');
  }
  return contentFromResponse(payload);
}

interface StreamRequestInit {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  response_format: { type: string };
  stream: boolean;
}

/**
 * 流式请求 /chat/completions：逐段回调 onDelta，结束后返回完整文本。
 * 网关不支持流式响应体时退回一次性 JSON，保证功能可用。
 */
export async function requestChatCompletionStream(
  settings: Pick<PupSettings, 'baseUrl' | 'apiKey' | 'model'>,
  messages: ChatMessage[],
  signal: AbortSignal,
  maxTokens = 1200,
  timeoutSeconds = 30,
  onDelta: (text: string) => void,
): Promise<string> {
  if (!settings.apiKey.trim()) throw new LlmError('请先在设置页填写 API Key', 'NO_KEY');
  if (!settings.model.trim()) throw new LlmError('请先填写模型名称', 'INVALID_CONFIG');
  const endpoint = normalizedEndpoint(settings.baseUrl);
  const body: StreamRequestInit = {
    model: settings.model.trim(),
    messages,
    temperature: 0.1,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    stream: true,
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      if (signal.reason === 'timeout') throw new LlmError(`请求超过 ${timeoutSeconds} 秒，已自动停止`, 'TIMEOUT');
      throw new LlmError('已取消本次阅读', 'ABORTED');
    }
    throw new LlmError(error instanceof Error ? `无法连接模型：${error.message}` : '无法连接模型', 'NETWORK');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new LlmError('API Key 无效或没有访问权限', 'AUTH');
    if (response.status === 429) throw new LlmError('模型请求过于频繁或额度不足，请稍后再试', 'RATE_LIMIT');
    if (response.status === 404) throw new LlmError('模型接口返回 HTTP 404，请检查 API 地址和模型名称是否正确', 'HTTP');
    throw new LlmError(`模型接口返回 HTTP ${response.status}`, 'HTTP');
  }

  if (!response.body) {
    // 个别网关忽略 stream 参数，退回一次性 JSON 解析。
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LlmError('模型接口返回了异常 JSON', 'BAD_RESPONSE');
    }
    const content = contentFromResponse(payload);
    onDelta(content);
    return content;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  let accumulated = '';
  let sawDone = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const events = parser.push(decoder.decode(value, { stream: true }));
      for (const event of events) {
        if ('done' in event) {
          sawDone = true;
          break; // [DONE] 之后不再期待增量。
        }
        const piece = deltaTextFromSseData(event.data);
        if (!piece) continue; // 心跳、usage 等非内容块直接忽略。
        accumulated += piece;
        onDelta(piece);
      }
      if (sawDone) break;
    }
  } catch (error) {
    if (signal.aborted) {
      if (signal.reason === 'timeout') throw new LlmError(`请求超过 ${timeoutSeconds} 秒，已自动停止`, 'TIMEOUT');
      throw new LlmError('已取消本次阅读', 'ABORTED');
    }
    throw new LlmError(error instanceof Error ? `流式读取中断：${error.message}` : '流式读取中断', 'NETWORK');
  }
  if (!accumulated.trim()) throw new LlmError('模型没有返回可读取的内容', 'BAD_RESPONSE');
  return accumulated;
}

export async function requestReadingStream(
  settings: Pick<PupSettings, 'baseUrl' | 'apiKey' | 'model'>,
  sources: SourceSegment[],
  operation: ReadingOperation,
  signal: AbortSignal,
  length: ReadingLength = 'bullets',
  timeoutSeconds = 30,
  onDelta: (text: string) => void,
): Promise<ReadingResult> {
  const content = await requestChatCompletionStream(
    settings,
    buildReadingMessages(sources, operation, length),
    signal,
    1200,
    timeoutSeconds,
    onDelta,
  );
  try {
    return readingResultFromModel(content, sources, operation, length);
  } catch (error) {
    if (error instanceof LlmError) throw error;
    throw new LlmError('模型没有遵守阅读 JSON 协议，请重试', 'BAD_RESPONSE');
  }
}
