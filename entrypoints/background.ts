import { LlmError, requestChatCompletion, requestReadingStream } from '../shared/llm';
import { isReadPortRequest, READ_PORT_NAME, type ReadPortRequest, type ReadPortResponse } from '../shared/readPort';
import { ALL_SITE_ORIGINS, getSettings, originPattern, saveSettings, shouldInjectOn } from '../shared/storage';
import { MAX_SELECTION_CHARACTERS, MAX_SELECTION_SEGMENTS } from '../shared/selection';
import type { PupSettings, ReadingOperation, SourceSegment } from '../shared/types';

const activeReads = new Map<string, AbortController>();

function installMainWorldErrorBridge() {
  const bridgeWindow = window as Window & {
    __pagePupErrorBridgeReady?: boolean;
    __pagePupErrorBridgeCleanup?: () => void;
  };
  if (bridgeWindow.__pagePupErrorBridgeReady) return;
  bridgeWindow.__pagePupErrorBridgeReady = true;
  let listening = false;
  const notify = () => {
    window.postMessage({ source: 'page-pup:error-bridge', type: 'page-error' }, window.location.origin);
  };
  const setEnabled = (enabled: boolean) => {
    if (enabled === listening) return;
    listening = enabled;
    if (enabled) {
      window.addEventListener('error', notify);
      window.addEventListener('unhandledrejection', notify);
    } else {
      window.removeEventListener('error', notify);
      window.removeEventListener('unhandledrejection', notify);
    }
  };
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.source !== 'page-pup' || event.data?.type !== 'page-pup:error-monitoring') return;
    setEnabled(event.data.enabled === true);
  };
  window.addEventListener('message', onMessage);
  bridgeWindow.__pagePupErrorBridgeCleanup = () => {
    setEnabled(false);
    window.removeEventListener('message', onMessage);
    bridgeWindow.__pagePupErrorBridgeReady = false;
    bridgeWindow.__pagePupErrorBridgeCleanup = undefined;
  };
  window.postMessage({ source: 'page-pup:error-bridge', type: 'ready' }, window.location.origin);
}

function cleanupMainWorldErrorBridge() {
  const bridgeWindow = window as Window & { __pagePupErrorBridgeCleanup?: () => void };
  bridgeWindow.__pagePupErrorBridgeCleanup?.();
}

async function injectPup(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-scripts/content.js'],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: installMainWorldErrorBridge,
  });
}

async function unmountPup(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'page-pup:unmount' });
  } catch {
    // 页面尚未注入或已关闭时无需处理。
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cleanupMainWorldErrorBridge,
    });
  } catch {
    // 页面已导航或不支持脚本时无需处理。
  }
}

async function removeSitePermissions(origins: string[]): Promise<void> {
  try {
    await chrome.permissions.remove({ origins });
  } catch {
    // 部分环境无法回收已授予的权限，不应阻断停用流程。
  }
}

async function injectIntoSites(settings: PupSettings): Promise<number> {
  const granted = new Map<string, boolean>();
  let injected = 0;
  for (const tab of await chrome.tabs.query({})) {
    if (!tab.id || !tab.url) continue;
    const pattern = originPattern(tab.url);
    if (!pattern || !shouldInjectOn(settings, pattern)) continue;
    if (!granted.has(pattern)) {
      granted.set(pattern, await chrome.permissions.contains({ origins: [pattern] }));
    }
    if (!granted.get(pattern)) continue;
    try {
      await injectPup(tab.id);
      injected += 1;
    } catch {
      // 受限页面或正在加载的标签页跳过。
    }
  }
  return injected;
}

async function unmountInactiveSites(settings: PupSettings): Promise<void> {
  for (const tab of await chrome.tabs.query({})) {
    if (!tab.id || !tab.url) continue;
    const pattern = originPattern(tab.url);
    if (!pattern || shouldInjectOn(settings, pattern)) continue;
    await unmountPup(tab.id);
  }
}

function validReadingInput(sources: unknown, operation: unknown): sources is SourceSegment[] {
  if (operation !== 'explain' && operation !== 'summarize' && operation !== 'translate') return false;
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_SELECTION_SEGMENTS) return false;
  let length = 0;
  return sources.every((source, index) => {
    if (!source || typeof source !== 'object') return false;
    const candidate = source as Partial<SourceSegment>;
    if (candidate.id !== `s${index + 1}` || typeof candidate.text !== 'string' || !candidate.text.trim()) return false;
    length += candidate.text.length;
    return length <= MAX_SELECTION_CHARACTERS;
  });
}

function failure(error: unknown) {
  if (error instanceof LlmError) return { ok: false, error: error.message, code: error.code };
  return {
    ok: false,
    error: error instanceof Error ? error.message : '阅读请求失败',
    code: 'REQUEST_FAILED',
  };
}

async function checkLlmAccess(settings: PupSettings): Promise<void> {
  if (!settings.apiKey.trim()) throw new LlmError('请先在设置页填写 API Key', 'NO_KEY');
  const apiPattern = originPattern(settings.baseUrl);
  if (!apiPattern) throw new LlmError('API 地址无效', 'INVALID_CONFIG');
  const apiGranted = await chrome.permissions.contains({ origins: [apiPattern] });
  if (!apiGranted) {
    throw new LlmError('请在设置页保存并授权模型 API 地址', 'API_PERMISSION');
  }
}

/**
 * 通过端口执行一次流式阅读：校验逻辑与一次性请求完全一致，
 * 校验失败或请求出错时回传 error，流式增量回传 delta，结束后回传 done。
 */
async function runReadViaPort(port: chrome.runtime.Port, request: ReadPortRequest, reads: Set<string>): Promise<void> {
  const { requestId, operation, length, scope, sources } = request;
  const respond = (message: ReadPortResponse) => {
    try {
      port.postMessage(message);
    } catch {
      // 端口已断开，结果无处投递，忽略即可；AbortController 会在断开时回收。
    }
  };

  let controller: AbortController | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!validReadingInput(sources, operation)) throw new Error('选区为空、过长或格式不正确');
    const sender = port.sender;
    if (!sender?.tab?.id || !sender.url) throw new Error('请从已启用的网页发起阅读');
    const settings = await getSettings();
    const sitePattern = originPattern(sender.url);
    if (!sitePattern || !shouldInjectOn(settings, sitePattern)) throw new Error('当前网站尚未启用伴读小宠物');
    await checkLlmAccess(settings);

    activeReads.get(requestId)?.abort('superseded');
    controller = new AbortController();
    activeReads.set(requestId, controller);
    reads.add(requestId);
    const timeoutSeconds = scope === 'page' ? 120 : 30;
    timeout = setTimeout(() => controller?.abort('timeout'), timeoutSeconds * 1000);

    const result = await requestReadingStream(
      settings,
      sources,
      operation,
      controller.signal,
      length,
      timeoutSeconds,
      (text) => respond({ type: 'delta', requestId, text }),
    );
    respond({ type: 'done', requestId, result });
  } catch (error) {
    const payload = failure(error);
    respond({ type: 'error', requestId, error: payload.error, code: payload.code });
  } finally {
    if (timeout) clearTimeout(timeout);
    reads.delete(requestId);
    if (controller && activeReads.get(requestId) === controller) activeReads.delete(requestId);
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'page-pup:enable-everywhere') {
      void (async () => {
        const granted = await chrome.permissions.contains({ origins: ALL_SITE_ORIGINS });
        if (!granted) throw new Error('尚未获得所有网站权限，请重新点击并允许');
        const settings = await getSettings();
        const next: PupSettings = { ...settings, enabledEverywhere: true, pausedSites: [] };
        await saveSettings(next);
        const count = await injectIntoSites(next);
        return { ok: true, count };
      })().then(sendResponse).catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === 'page-pup:disable-everywhere') {
      void (async () => {
        const settings = await getSettings();
        const next: PupSettings = { ...settings, enabledEverywhere: false };
        await saveSettings(next);
        await unmountInactiveSites(next);
        await removeSitePermissions(ALL_SITE_ORIGINS);
        return { ok: true };
      })().then(sendResponse).catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === 'page-pup:enable-active-tab') {
      void (async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url) throw new Error('找不到当前标签页');
        const pattern = originPattern(tab.url);
        if (!pattern) throw new Error('当前页面不支持启用');

        const settings = await getSettings();
        if (settings.enabledEverywhere) {
          await saveSettings({
            ...settings,
            pausedSites: settings.pausedSites.filter((site) => site !== pattern),
          });
          await injectPup(tab.id);
          return { ok: true };
        }

        const granted = await chrome.permissions.contains({ origins: [pattern] });
        if (!granted) throw new Error('尚未获得当前网站权限');

        const enabledSites = Array.from(new Set([...settings.enabledSites, pattern]));
        await saveSettings({ ...settings, enabledSites });
        await injectPup(tab.id);
        return { ok: true };
      })().then(sendResponse).catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === 'page-pup:disable-active-tab') {
      void (async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url) throw new Error('找不到当前标签页');
        const pattern = originPattern(tab.url);
        const settings = await getSettings();

        if (settings.enabledEverywhere) {
          if (!pattern) throw new Error('当前页面不支持启用');
          await saveSettings({
            ...settings,
            pausedSites: Array.from(new Set([...settings.pausedSites, pattern])),
          });
          await unmountPup(tab.id);
          return { ok: true };
        }

        await saveSettings({
          ...settings,
          enabledSites: settings.enabledSites.filter((site) => site !== pattern),
        });
        await unmountPup(tab.id);
        if (pattern) await removeSitePermissions([pattern]);
        return { ok: true };
      })().then(sendResponse).catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === 'page-pup:test-llm') {
      void (async () => {
        if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('options.html')) {
          throw new Error('只能从扩展设置页测试连接');
        }
        const settings = await getSettings();
        await checkLlmAccess(settings);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort('timeout'), 30000);
        try {
          await requestChatCompletion(
            settings,
            [{ role: 'user', content: '这是一项连接测试。只输出 JSON：{"ok":true}。' }],
            controller.signal,
            32,
          );
          return { ok: true };
        } finally {
          clearTimeout(timeout);
        }
      })().then(sendResponse).catch((error) => sendResponse(failure(error)));
      return true;
    }

    if (message?.type === 'page-pup:open-options') {
      void chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  // 内容脚本通过长连接端口发起阅读，流式回传逐字草稿；取消即断开端口。
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== READ_PORT_NAME) return;
    const reads = new Set<string>();
    port.onDisconnect.addListener(() => {
      for (const requestId of reads) {
        activeReads.get(requestId)?.abort('cancelled');
        activeReads.delete(requestId);
      }
      reads.clear();
    });
    port.onMessage.addListener((message: unknown) => {
      if (!isReadPortRequest(message)) return;
      void runReadViaPort(port, message, reads).catch(() => undefined);
    });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !tab.url) return;
    void (async () => {
      const pattern = originPattern(tab.url!);
      if (!pattern) return;
      const settings = await getSettings();
      if (!shouldInjectOn(settings, pattern)) return;
      const granted = await chrome.permissions.contains({ origins: [pattern] });
      if (granted) await injectPup(tabId);
    })().catch(() => undefined);
  });
});
