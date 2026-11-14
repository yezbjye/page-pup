import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionReloadedError, extensionAlive, sendRuntimeMessage } from '../shared/runtime';

const originalChrome = (globalThis as { chrome?: unknown }).chrome;

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

describe('扩展消息通道', () => {
  it('扩展上下文正常时返回后台响应', async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: 'extension-id', sendMessage: async () => ({ ok: true }) },
    };
    await expect(sendRuntimeMessage({ type: 'ping' })).resolves.toEqual({ ok: true });
    expect(extensionAlive()).toBe(true);
  });

  it('扩展重新加载导致 sendMessage 丢失时给出刷新提示', async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        id: 'extension-id',
        sendMessage: () => {
          throw new TypeError("Cannot read properties of undefined (reading 'sendMessage')");
        },
      },
    };
    await expect(sendRuntimeMessage({ type: 'ping' })).rejects.toBeInstanceOf(ExtensionReloadedError);
    await expect(sendRuntimeMessage({ type: 'ping' })).rejects.toThrow('请刷新此页面');
  });

  it('扩展上下文已失效时不尝试发送', async () => {
    (globalThis as { chrome?: unknown }).chrome = {};
    await expect(sendRuntimeMessage({ type: 'ping' })).rejects.toThrow('请刷新此页面');
    expect(extensionAlive()).toBe(false);
  });
});
