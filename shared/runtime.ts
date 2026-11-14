export class ExtensionReloadedError extends Error {
  constructor() {
    super('扩展刚刚更新或重新加载，请刷新此页面后再试');
    this.name = 'ExtensionReloadedError';
  }
}

export function extensionAlive(): boolean {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function isInvalidated(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Extension context invalidated|sendMessage|Receiving end does not exist/i.test(message);
}

export async function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  if (!extensionAlive()) throw new ExtensionReloadedError();
  try {
    return await chrome.runtime.sendMessage(message) as T;
  } catch (error) {
    if (isInvalidated(error)) throw new ExtensionReloadedError();
    throw error;
  }
}
