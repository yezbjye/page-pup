import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BookMarked, Eye, EyeOff, FileJson, FileText, History, ImagePlus, LoaderCircle, PlugZap, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { fileToCustomImage, isSafeCustomImage } from '../../shared/customImage';
import { getGlossary, GLOSSARY_MAX_ENTRIES, type GlossaryEntry } from '../../shared/glossary';
import { normalizeBaseUrl } from '../../shared/llm';
import { clearReminderRecords, getReminderRecords, getSettings, originPattern, saveSettings } from '../../shared/storage';
import { BREAK_MINUTES_OPTIONS, CUSTOM_NAME_MAX_LENGTH, DEFAULT_SETTINGS, PET_OPTIONS, REMINDER_LABELS, petOption, pupDisplayName, type BreakMinutes, type PetId, type PupSettings, type ReminderRecord, type ReminderType } from '../../shared/types';
import './styles.css';

const reminderTypes: ReminderType[] = ['reading', 'form', 'error'];

function downloadTextFile(content: string, fileName: string, mimeType: string) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Options() {
  const [settings, setSettings] = useState<PupSettings>(DEFAULT_SETTINGS);
  const [records, setRecords] = useState<ReminderRecord[]>([]);
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const [breakDialogOpen, setBreakDialogOpen] = useState(false);
  const [breakDraft, setBreakDraft] = useState<BreakMinutes>(DEFAULT_SETTINGS.breakReminderMinutes);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void Promise.all([getSettings(), getReminderRecords(), getGlossary()]).then(([storedSettings, storedRecords, storedGlossary]) => {
      setSettings(storedSettings);
      setRecords(storedRecords);
      setGlossary(storedGlossary);
      setLoading(false);
    }).catch((error: Error) => {
      setNotice(error.message);
      setLoading(false);
    });
  }, []);

  const exportGlossary = (format: 'json' | 'markdown') => {
    if (!glossary.length) return;
    const stamp = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const dateLabel = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`;
    if (format === 'json') {
      downloadTextFile(JSON.stringify(glossary, null, 2), `伴读术语本-${dateLabel}.json`, 'application/json');
    } else {
      const lines = [
        '# 伴读术语本',
        '',
        `共 ${glossary.length} 条 · 导出于 ${stamp.toLocaleString('zh-CN')}`,
        '',
        ...glossary.map((entry) => `- **${entry.term}**：${entry.definition}${entry.sourceOrigin ? `（来自 ${entry.sourceOrigin}）` : ''}`),
      ];
      downloadTextFile(lines.join('\n'), `伴读术语本-${dateLabel}.md`, 'text/markdown');
    }
    setNotice(format === 'json' ? '术语本已导出为 JSON 文件' : '术语本已导出为 Markdown 文件');
    setNoticeError(false);
  };

  const update = <K extends keyof PupSettings>(key: K, value: PupSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setTestStatus('idle');
    setNotice('');
    setNoticeError(false);
  };

  const save = async (pendingMessage?: string): Promise<boolean> => {
    setSaving(true);
    setNotice('');
    setNoticeError(false);
    try {
      const baseUrl = normalizeBaseUrl(settings.baseUrl.trim());
      const model = settings.model.trim();
      if (!model) throw new Error('请填写模型名称');
      const next = { ...settings, baseUrl, model, apiKey: settings.apiKey.trim() };
      const apiPattern = originPattern(baseUrl);
      if (!apiPattern) throw new Error('API 地址无效');
      const granted = await chrome.permissions.request({ origins: [apiPattern] });
      if (!granted) throw new Error('你没有授予模型 API 地址权限，设置尚未保存');
      await saveSettings(next);
      setSettings(next);
      setNotice(pendingMessage ?? (next.apiKey
        ? '设置已保存在此浏览器，并已授权模型 API 地址'
        : '设置已保存；阅读前还需要填写你的 API Key'));
      return true;
    } catch (error) {
      setNoticeError(true);
      setNotice(error instanceof Error ? error.message : '设置保存失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (!settings.apiKey.trim()) {
      setTestStatus('error');
      setNoticeError(true);
      setNotice('请先填写你自己的 API Key，再测试连接');
      return;
    }
    setTesting(true);
    setTestStatus('idle');
    try {
      const saved = await save('当前配置已保存，正在测试连接…');
      if (!saved) {
        setTestStatus('error');
        return;
      }
      const response = await chrome.runtime.sendMessage({ type: 'page-pup:test-llm' });
      if (!response?.ok) throw new Error(response?.error ?? '连接测试失败');
      setTestStatus('success');
      setNoticeError(false);
      setNotice('连接成功：API 地址、Key 和模型配置均可用');
    } catch (error) {
      setTestStatus('error');
      setNoticeError(true);
      setNotice(error instanceof Error ? error.message : '连接测试失败');
    } finally {
      setTesting(false);
    }
  };

  const toggleReminder = (type: ReminderType) => {
    update('mutedReminders', settings.mutedReminders.includes(type)
      ? settings.mutedReminders.filter((item) => item !== type)
      : [...settings.mutedReminders, type]);
  };

  const chooseThreshold = async (minutes: 1 | 3 | 8) => {
    setSettings((current) => ({ ...current, readingThresholdMinutes: minutes }));
    setNotice('');
    setNoticeError(false);
    try {
      const stored = await getSettings();
      await saveSettings({ ...stored, readingThresholdMinutes: minutes });
      setNotice(`阅读提醒门槛已改为 ${minutes} 分钟`);
    } catch (error) {
      setNoticeError(true);
      setNotice(error instanceof Error ? error.message : '门槛保存失败');
    }
  };

  const breakMuted = settings.mutedReminders.includes('break');
  const breakEnabled = settings.breakReminderEnabled && !breakMuted;

  const toggleBreak = async (next: boolean) => {
    setNotice('');
    setNoticeError(false);
    if (next) {
      setBreakDraft(settings.breakReminderMinutes);
      setBreakDialogOpen(true);
      return;
    }
    try {
      const stored = await getSettings();
      await saveSettings({ ...stored, breakReminderEnabled: false });
      setSettings((current) => ({ ...current, breakReminderEnabled: false }));
      setNotice('休息提醒已关闭');
    } catch (error) {
      setNoticeError(true);
      setNotice(error instanceof Error ? error.message : '休息提醒保存失败');
    }
  };

  const confirmBreak = async () => {
    try {
      const stored = await getSettings();
      const next = {
        ...stored,
        breakReminderEnabled: true,
        breakReminderMinutes: breakDraft,
        mutedReminders: stored.mutedReminders.filter((item) => item !== 'break'),
      };
      await saveSettings(next);
      setSettings((current) => ({
        ...current,
        breakReminderEnabled: true,
        breakReminderMinutes: breakDraft,
        mutedReminders: current.mutedReminders.filter((item) => item !== 'break'),
      }));
      setBreakDialogOpen(false);
      setNoticeError(false);
      setNotice(`休息提醒已开启：每 ${breakDraft} 分钟一次`);
    } catch (error) {
      setNoticeError(true);
      setNotice(error instanceof Error ? error.message : '休息提醒保存失败');
    }
  };

  const toggleIdleNudges = async (next: boolean) => {
    setSettings((current) => ({ ...current, idleNudgesEnabled: next }));
    setNotice('');
    setNoticeError(false);
    try {
      const stored = await getSettings();
      await saveSettings({ ...stored, idleNudgesEnabled: next });
      setNotice(next ? '空闲随机互动已开启' : '空闲随机互动已关闭');
    } catch (error) {
      setNoticeError(true);
      setNotice(error instanceof Error ? error.message : '互动设置保存失败');
    }
  };

  const choosePet = async (pet: PetId) => {
    if (pet === 'custom' && !isSafeCustomImage(settings.customImage)) {
      setNoticeError(true);
      setNotice('请先上传一张图片，再使用自定义形象');
      return;
    }
    setSettings((current) => ({ ...current, pet }));
    setNotice('');
    setNoticeError(false);
    try {
      const stored = await getSettings();
      await saveSettings({ ...stored, pet });
      setNotice(`已切换为${pet === 'custom' ? '自定义形象' : petOption(pet).label}，已打开的网页会立即更新`);
    } catch (error) {
      setNoticeError(true);
      setNotice(error instanceof Error ? error.message : '形象保存失败');
    }
  };

  const saveCustomName = async () => {
    const customName = settings.customName.trim().slice(0, CUSTOM_NAME_MAX_LENGTH);
    setSettings((current) => ({ ...current, customName }));
    setNotice('');
    setNoticeError(false);
    try {
      const stored = await getSettings();
      await saveSettings({ ...stored, customName });
      setNotice(customName ? `显示名称已改为「${customName}」` : '已恢复默认名称');
    } catch (error) {
      setNoticeError(true);
      setNotice(error instanceof Error ? error.message : '名称保存失败');
    }
  };

  const uploadCustomImage = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setNotice('');
    setNoticeError(false);
    try {
      const customImage = await fileToCustomImage(file);
      const stored = await getSettings();
      await saveSettings({ ...stored, customImage, pet: 'custom' });
      setSettings((current) => ({ ...current, customImage, pet: 'custom' }));
      setNotice('自定义形象已上传并启用，已打开的网页会立即更新');
    } catch (error) {
      setNoticeError(true);
      setNotice(error instanceof Error ? error.message : '图片上传失败');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  if (loading) return <main className="options-shell"><p>正在读取本地设置…</p></main>;

  return (
    <main className="options-shell">
      <aside className="options-aside">
        <div className="options-dog" aria-hidden="true">
          <img src={settings.pet === 'custom' && isSafeCustomImage(settings.customImage) ? settings.customImage : chrome.runtime.getURL(petOption(settings.pet).file)} alt="" />
        </div>
        <h1>伴读伙伴设置</h1>
        <p>安静阅读，只围绕选中的原文。</p>
        <div className="options-privacy"><ShieldCheck size={17} /> 所有设置仅保存在本地</div>
      </aside>

      <div className="options-content">
        <section className="options-section">
          <div className="options-section-heading"><span>01</span><div><h2>连接你的模型</h2><p>使用 OpenAI 兼容接口，地址填到 /v1 即可，Key 由你自己填写和保管。</p></div></div>
          <fieldset className="options-fields" disabled={saving || testing}>
            <div className="options-form-grid">
              <label className="options-field options-field-wide"><span>API 地址</span><input value={settings.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} placeholder="https://api.openai.com/v1" spellCheck={false} /></label>
              <label className="options-field"><span>API Key</span><div className="options-key-input"><input type={showKey ? 'text' : 'password'} value={settings.apiKey} onChange={(event) => update('apiKey', event.target.value)} placeholder="由你最后配置" autoComplete="off" spellCheck={false} /><button type="button" onClick={() => setShowKey((show) => !show)} aria-label={showKey ? '隐藏 Key' : '显示 Key'}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
              <label className="options-field"><span>模型名称</span><input value={settings.model} onChange={(event) => update('model', event.target.value)} placeholder="例如：gpt-4o-mini" spellCheck={false} /></label>
            </div>
          </fieldset>
          <div className="options-actions">
            <button className="options-primary" disabled={saving || testing} onClick={() => void save()}><Save size={16} /> {saving ? '正在保存…' : '保存设置'}</button>
            <button className="options-secondary" disabled={saving || testing} onClick={() => void testConnection()}>{testing ? <LoaderCircle className="options-spin" size={16} /> : <PlugZap size={16} />} {testing ? '正在测试…' : '测试连接'}</button>
            <span className={`options-test-state ${testStatus}`} aria-live="polite">{testing ? '正在通过阅读链路验证当前配置' : testStatus === 'success' ? '连接测试通过' : testStatus === 'error' ? '连接未成功，请查看提示' : '测试会保存当前配置，不会发送网页内容'}</span>
          </div>
        </section>

        <section className="options-section">
          <div className="options-section-heading"><span>02</span><div><h2>名称与陪伴形象</h2><p>可以给工具起自己的名字，也可以上传图片作为悬浮形象，已打开的网页会立即更新。</p></div></div>
          <div className="options-custom-name">
            <label className="options-field"><span>显示名称（留空恢复默认「伴读小狗」，最多 {CUSTOM_NAME_MAX_LENGTH} 字）</span><input value={settings.customName} maxLength={CUSTOM_NAME_MAX_LENGTH} placeholder={pupDisplayName(DEFAULT_SETTINGS)} onChange={(event) => update('customName', event.target.value)} onBlur={() => void saveCustomName()} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveCustomName(); } }} /></label>
            <button type="button" className="options-secondary" disabled={uploading} onClick={() => void saveCustomName()}>保存名称</button>
          </div>
          <div className="options-pet-grid">
            {PET_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`options-pet-card ${settings.pet === option.id ? 'is-selected' : ''}`}
                aria-pressed={settings.pet === option.id}
                onClick={() => void choosePet(option.id)}
              >
                <img src={chrome.runtime.getURL(option.file)} alt="" />
                <span>{option.label}</span>
              </button>
            ))}
            <button
              type="button"
              className={`options-pet-card ${settings.pet === 'custom' ? 'is-selected' : ''}`}
              aria-pressed={settings.pet === 'custom'}
              onClick={() => void choosePet('custom')}
            >
              {isSafeCustomImage(settings.customImage) ? <img src={settings.customImage} alt="" /> : <ImagePlus size={30} />}
              <span>自定义</span>
            </button>
          </div>
          <div className="options-custom-upload">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="options-file-input"
              aria-label="选择自定义形象图片"
              onChange={(event) => void uploadCustomImage(event.target.files?.[0])}
            />
            <button type="button" className="options-secondary" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
              {uploading ? <LoaderCircle className="options-spin" size={16} /> : <ImagePlus size={16} />} {uploading ? '正在处理图片…' : '上传图片作为悬浮形象'}
            </button>
            <span>支持 PNG / JPG / WebP，不超过 5 MB；会压缩到 256px 内并只保存在本地。</span>
          </div>
        </section>

        <section className="options-section">
          <div className="options-section-heading"><span>03</span><div><h2>提醒要有分寸</h2><p>关闭的类别只会留在本地记录里，不再主动弹出。</p></div></div>
          <div className="options-switch-row"><div><strong>允许安静提醒</strong><p>总开关关闭后，不再监测新的提醒事件</p></div><button role="switch" aria-checked={settings.remindersEnabled} className={`options-switch ${settings.remindersEnabled ? 'is-on' : ''}`} onClick={() => update('remindersEnabled', !settings.remindersEnabled)}><span /></button></div>
          {reminderTypes.map((type) => {
            const enabled = !settings.mutedReminders.includes(type);
            return <div className="options-switch-row" key={type}><div><strong>{REMINDER_LABELS[type]}</strong><p>{type === 'reading' ? '活跃阅读较久且多次来回滚动' : type === 'form' ? '只感知填写事件，不读取填写内容' : '只感知操作后的错误事件，不读取堆栈'}</p></div><button role="switch" aria-checked={enabled} className={`options-switch ${enabled ? 'is-on' : ''}`} onClick={() => toggleReminder(type)}><span /></button></div>;
          })}
          <div className="options-threshold-row">
            <div><strong>阅读提醒门槛</strong><p>可见阅读达到此时长，并来回滚动 3 次，才会提醒。</p></div>
            <div className="options-threshold-options">
              {([1, 3, 8] as const).map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  className={settings.readingThresholdMinutes === minutes ? 'is-selected' : ''}
                  aria-pressed={settings.readingThresholdMinutes === minutes}
                  onClick={() => void chooseThreshold(minutes)}
                >
                  {minutes} 分钟
                </button>
              ))}
            </div>
          </div>
          <div className="options-switch-row">
            <div>
              <strong>休息提醒</strong>
              <p>{breakEnabled ? `每 ${settings.breakReminderMinutes} 分钟提醒你起身活动，可随时关闭` : '开启时可设置 30 / 45 / 60 分钟'}</p>
            </div>
            <button role="switch" aria-checked={breakEnabled} className={`options-switch ${breakEnabled ? 'is-on' : ''}`} onClick={() => void toggleBreak(!breakEnabled)}><span /></button>
          </div>
          <div className="options-switch-row">
            <div>
              <strong>空闲随机互动</strong>
              <p>安静一会儿后偶尔冒一句功能提示，不抢焦点，也不打断正在进行的操作</p>
            </div>
            <button role="switch" aria-checked={settings.idleNudgesEnabled} className={`options-switch ${settings.idleNudgesEnabled ? 'is-on' : ''}`} onClick={() => void toggleIdleNudges(!settings.idleNudgesEnabled)}><span /></button>
          </div>
        </section>

        <section className="options-section">
          <div className="options-section-heading"><span>04</span><div><h2>本地提醒记录</h2><p>最多保留最近 100 条，包括被冷却和静音规则忍住的提醒。</p></div></div>
          {records.length === 0 ? <div className="options-empty"><History size={20} /> 暂无提醒记录</div> : <div className="options-record-list">{records.slice(0, 8).map((record) => <article className="options-record" key={record.id}><div><strong>{REMINDER_LABELS[record.type]}</strong><time>{new Date(record.createdAt).toLocaleString('zh-CN')}</time></div><p>{record.message}</p><small>{record.suppressionReason ?? '已展示'} · {record.reason}</small></article>)}</div>}
          {records.length > 0 && <button className="options-clear" onClick={() => void clearReminderRecords().then(() => setRecords([]))}><Trash2 size={15} /> 清空记录</button>}
        </section>

        <section className="options-section">
          <div className="options-section-heading"><span>05</span><div><h2>本地术语本</h2><p>收录的术语与释义只保存在此浏览器，启用站点会自动标出；最多保留 {GLOSSARY_MAX_ENTRIES} 条，超出自动移除最旧的。</p></div></div>
          <div className="options-glossary-row">
            <div className="options-glossary-count"><BookMarked size={18} /> 共 <strong>{glossary.length}</strong> 条术语</div>
            <div className="options-glossary-actions">
              <button type="button" className="options-secondary" disabled={!glossary.length} onClick={() => exportGlossary('json')}><FileJson size={15} /> 导出 JSON</button>
              <button type="button" className="options-secondary" disabled={!glossary.length} onClick={() => exportGlossary('markdown')}><FileText size={15} /> 导出 Markdown</button>
            </div>
          </div>
          {glossary.length === 0 ? <div className="options-empty">还没有收录术语</div> : (
            <div className="options-glossary-list">
              {glossary.slice(0, 6).map((entry) => (
                <article className="options-glossary-item" key={entry.id}>
                  <strong>{entry.term}</strong>
                  <p>{entry.definition}</p>
                </article>
              ))}
              {glossary.length > 6 && <small className="options-glossary-more">还有 {glossary.length - 6} 条，可在网页面板的「术语本」里查看全部</small>}
            </div>
          )}
        </section>

        <footer className="options-footer"><ShieldCheck size={16} /> 仅选区会发送至你配置的模型，不读取或保存完整网页。修改后请点击保存设置。</footer>
        {notice && <div className={`options-notice ${noticeError ? 'is-error' : ''}`} role="status">{notice}</div>}
      </div>
      {breakDialogOpen && (
        <div className="options-modal-backdrop" onClick={() => setBreakDialogOpen(false)}>
          <div className="options-modal" role="dialog" aria-modal="true" aria-labelledby="break-dialog-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="break-dialog-title">设置休息提醒</h3>
            <p>每隔多久提醒你起身活动？提醒会遵守总开关，也可以随时关闭。</p>
            <div className="options-threshold-options">
              {BREAK_MINUTES_OPTIONS.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  className={breakDraft === minutes ? 'is-selected' : ''}
                  aria-pressed={breakDraft === minutes}
                  onClick={() => setBreakDraft(minutes)}
                >
                  {minutes} 分钟
                </button>
              ))}
            </div>
            <div className="options-modal-actions">
              <button type="button" className="options-secondary" onClick={() => setBreakDialogOpen(false)}>取消</button>
              <button type="button" className="options-primary" onClick={() => void confirmBreak()}>开启提醒</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Options /></React.StrictMode>);
