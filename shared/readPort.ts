import type { ReadingLength, ReadingOperation, ReadingResult, SourceSegment } from './types';

/**
 * 内容脚本与后台之间的阅读长连接协议。
 * 内容脚本对每次阅读调用 chrome.runtime.connect 建立端口，
 * 后台流式回传 delta，最后回传 done 或 error；取消就是断开端口。
 */
export const READ_PORT_NAME = 'page-pup:read';

export interface ReadPortRequest {
  type: 'read';
  requestId: string;
  operation: ReadingOperation;
  length: ReadingLength;
  scope: 'selection' | 'page';
  sources: SourceSegment[];
}

export type ReadPortResponse =
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'done'; requestId: string; result: ReadingResult }
  | { type: 'error'; requestId: string; error: string; code?: string };

const OPERATIONS: ReadingOperation[] = ['explain', 'summarize', 'translate'];
const LENGTHS: ReadingLength[] = ['one', 'three', 'bullets'];

export function isReadPortRequest(value: unknown): value is ReadPortRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ReadPortRequest>;
  if (candidate.type !== 'read' || typeof candidate.requestId !== 'string' || !candidate.requestId) return false;
  if (!OPERATIONS.includes(candidate.operation as ReadingOperation)) return false;
  if (!LENGTHS.includes(candidate.length as ReadingLength)) return false;
  if (candidate.scope !== 'selection' && candidate.scope !== 'page') return false;
  return Array.isArray(candidate.sources);
}

export function isReadPortResponse(value: unknown): value is ReadPortResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ReadPortResponse> & { requestId?: unknown };
  if (typeof candidate.requestId !== 'string' || !candidate.requestId) return false;
  if (candidate.type === 'delta') return typeof candidate.text === 'string';
  if (candidate.type === 'done') return Boolean(candidate.result);
  if (candidate.type === 'error') return typeof candidate.error === 'string';
  return false;
}
