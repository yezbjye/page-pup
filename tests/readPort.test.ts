import { describe, expect, it } from 'vitest';
import { isReadPortRequest, isReadPortResponse, READ_PORT_NAME, type ReadPortRequest, type ReadPortResponse } from '../shared/readPort';

const validRequest: ReadPortRequest = {
  type: 'read',
  requestId: 'req-1',
  operation: 'explain',
  length: 'bullets',
  scope: 'selection',
  sources: [{ id: 's1', text: '选区原文' }],
};

describe('阅读端口协议', () => {
  it('端口名称固定为 page-pup:read', () => {
    expect(READ_PORT_NAME).toBe('page-pup:read');
  });

  it('接受合法的阅读请求', () => {
    expect(isReadPortRequest(validRequest)).toBe(true);
    expect(isReadPortRequest({ ...validRequest, operation: 'translate', scope: 'page', length: 'one' })).toBe(true);
  });

  it.each([
    ['缺少 requestId', { ...validRequest, requestId: '' }],
    ['非法操作', { ...validRequest, operation: 'chat' }],
    ['非法长度', { ...validRequest, length: 'huge' }],
    ['非法范围', { ...validRequest, scope: 'chapter' }],
    ['sources 不是数组', { ...validRequest, sources: 's1' }],
    ['缺少 type', { requestId: 'req-1', operation: 'explain', length: 'bullets', scope: 'selection', sources: [] }],
    ['非对象', null],
  ])('拒绝畸形请求：%s', (_name, value) => {
    expect(isReadPortRequest(value)).toBe(false);
  });

  it('接受 delta、done、error 三种回包', () => {
    const delta: ReadPortResponse = { type: 'delta', requestId: 'req-1', text: '逐' };
    const done: ReadPortResponse = {
      type: 'done',
      requestId: 'req-1',
      result: { status: 'insufficient', items: [], sources: [], operation: 'explain' },
    };
    const failure: ReadPortResponse = { type: 'error', requestId: 'req-1', error: '失败', code: 'NO_KEY' };
    expect(isReadPortResponse(delta)).toBe(true);
    expect(isReadPortResponse(done)).toBe(true);
    expect(isReadPortResponse(failure)).toBe(true);
  });

  it.each([
    ['delta 缺少文本', { type: 'delta', requestId: 'req-1' }],
    ['done 缺少结果', { type: 'done', requestId: 'req-1' }],
    ['error 缺少消息', { type: 'error', requestId: 'req-1' }],
    ['未知类型', { type: 'ping', requestId: 'req-1' }],
    ['缺少 requestId', { type: 'delta', text: 'x' }],
  ])('拒绝畸形回包：%s', (_name, value) => {
    expect(isReadPortResponse(value)).toBe(false);
  });
});
