import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BookOpenText, Globe2, Settings2 } from 'lucide-react';
import { ALL_SITE_ORIGINS, getSettings, originPattern } from '../../shared/storage';
import { DEFAULT_SETTINGS, pupDisplayName, type PupSettings } from '../../shared/types';
import './styles.css';

function Popup() {
  const [pattern, setPattern] = useState<string | null>(null);
  const [settings, setSettings] = useState<PupSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      getSettings(),
    ]).then(([tabs, storedSettings]) => {
      setPattern(tabs[0]?.url ? originPattern(tabs[0].url) : null);
      setSettings(storedSettings);
    }).catch((error: Error) => setMessage(error.message));
  }, []);

  const everywhere = settings.enabledEverywhere;
  const paused = Boolean(pattern && settings.pausedSites.includes(pattern));
  const siteEnabled = Boolean(pattern && settings.enabledSites.includes(pattern));

  const enableEverywhere = async () => {
    setBusy(true);
    setMessage('');
    try {
      const granted = await chrome.permissions.request({ origins: ALL_SITE_ORIGINS });
      if (!granted) throw new Error('你没有授予所有网站权限');
      const response = await chrome.runtime.sendMessage({ type: 'page-pup:enable-everywhere' });
      if (!response?.ok) throw new Error(response?.error ?? '启用失败');
      setSettings((current) => ({ ...current, enabledEverywhere: true, pausedSites: [] }));
      setMessage(`已在所有网站启用，${response.count ?? 0} 个已打开页面已就绪`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '启用失败');
    } finally {
      setBusy(false);
    }
  };

  const disableEverywhere = async () => {
    setBusy(true);
    setMessage('');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'page-pup:disable-everywhere' });
      if (!response?.ok) throw new Error(response?.error ?? '停止失败');
      setSettings((current) => ({ ...current, enabledEverywhere: false }));
      setMessage('已停止在所有网站启用');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const toggleSite = async () => {
    if (!pattern) return;
    setBusy(true);
    setMessage('');
    try {
      if (everywhere) {
        const response = await chrome.runtime.sendMessage({
          type: paused ? 'page-pup:enable-active-tab' : 'page-pup:disable-active-tab',
        });
        if (!response?.ok) throw new Error(response?.error ?? '操作失败');
        setSettings((current) => ({
          ...current,
          pausedSites: paused
            ? current.pausedSites.filter((site) => site !== pattern)
            : Array.from(new Set([...current.pausedSites, pattern])),
        }));
        setMessage(paused ? '已在此网站恢复小狗' : '已在此网站暂停，其他网站不受影响');
        return;
      }

      if (siteEnabled) {
        const response = await chrome.runtime.sendMessage({ type: 'page-pup:disable-active-tab' });
        if (!response?.ok) throw new Error(response?.error ?? '操作失败');
        setSettings((current) => ({
          ...current,
          enabledSites: current.enabledSites.filter((site) => site !== pattern),
        }));
        setMessage('已从当前网站移除');
        return;
      }

      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) throw new Error('你没有授予当前网站权限');
      const response = await chrome.runtime.sendMessage({ type: 'page-pup:enable-active-tab' });
      if (!response?.ok) throw new Error(response?.error ?? '启用失败');
      setSettings((current) => ({
        ...current,
        enabledSites: Array.from(new Set([...current.enabledSites, pattern])),
      }));
      setMessage('已启用，小狗会留在页面右下角');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const heading = everywhere
    ? (paused ? '已在此网站暂停' : '小狗在你打开的网页待命')
    : siteEnabled ? '正在陪你读这一页' : '让小狗安静地陪你阅读';

  return (
    <main className="popup-shell">
      <div className="popup-brand"><BookOpenText size={21} /><strong>{pupDisplayName(settings)}</strong></div>
      <h1>{heading}</h1>
      <p>选中文字后再解释或提炼。只有你的选区会用于生成，不读取整页。</p>

      {everywhere && (
        <div className="popup-global-state"><Globe2 size={14} /> 已在所有网站启用</div>
      )}

      {pattern ? (
        <button
          className={everywhere ? (paused ? 'popup-primary' : 'popup-secondary') : 'popup-secondary'}
          disabled={busy}
          onClick={() => void toggleSite()}
        >
          {busy ? '正在处理…' : everywhere
            ? (paused ? '在此网站恢复' : '在此网站暂停')
            : siteEnabled ? '在此网站停用' : '仅在此网站启用'}
        </button>
      ) : (
        <div className="popup-unsupported">当前浏览器页面不支持注入扩展</div>
      )}

      {everywhere ? (
        <button className="popup-settings" disabled={busy} onClick={() => void disableEverywhere()}>
          停止在所有网站启用
        </button>
      ) : (
        <button className="popup-primary popup-everywhere" disabled={busy} onClick={() => void enableEverywhere()}>
          <Globe2 size={15} /> 在所有网站启用
        </button>
      )}

      <button className="popup-settings" onClick={() => void chrome.runtime.openOptionsPage()}>
        <Settings2 size={15} /> 设置 LLM 与提醒
      </button>
      {message && <div className="popup-message" role="status">{message}</div>}
      <div className="popup-host">{pattern ?? '受限页面'}</div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Popup /></React.StrictMode>);
