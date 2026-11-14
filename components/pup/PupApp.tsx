import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BellOff, BookMarked, BookmarkPlus, BookOpenText, Download, History, Languages, ListOrdered, LoaderCircle, LocateFixed, Minus, Settings2, Trash2, X } from 'lucide-react';
import { clearGlossary, deleteGlossaryEntry, getGlossary, GLOSSARY_KEY, GLOSSARY_MAX_ENTRIES, normalizeGlossaryTerm, saveGlossaryEntries, type GlossaryEntry } from '../../shared/glossary';
import { extractPageSnapshot } from '../../shared/page';
import { Pet, type PetIdleAction } from './Pet';
import { useReminders } from './useReminders';
import { createGlossaryHighlight, type GlossaryHighlightController } from './glossaryHighlight';
import { captureSelection, highlightSourceRange, MAX_SELECTION_CHARACTERS, MAX_SELECTION_SEGMENTS, type SelectionSnapshot } from '../../shared/selection';
import { getSettings, getSitePosition, getUiState, saveSitePosition, saveUiState, SETTINGS_KEY } from '../../shared/storage';
import { NUDGE_GAP_MS, nudgeDelayMs, pickNudge } from '../../shared/nudges';
import { draftItemsFromStream } from '../../shared/reading';
import { isReadPortResponse, READ_PORT_NAME } from '../../shared/readPort';
import { extensionAlive, sendRuntimeMessage } from '../../shared/runtime';
import { DEFAULT_SETTINGS, READING_LENGTH_LABELS, REMINDER_LABELS, pupDisplayName, type PetId, type PupUiState, type ReadingItem, type ReadingLength, type ReadingOperation, type ReadingResult, type ReminderRecord, type ReminderStatus, type SourceSegment } from '../../shared/types';

const DOG_SIZE = 68;
const VIEWPORT_GAP = 12;
/** 闲置超过 2 分钟进入休眠态。 */
const SLEEP_AFTER_MS = 2 * 60 * 1000;
const IDLE_ACTION_MIN_MS = 30 * 1000;
const IDLE_ACTION_RANGE_MS = 60 * 1000;
const IDLE_ACTION_HOLD_MS = 1500;
const IDLE_ACTIONS: PetIdleAction[] = ['tilt', 'stretch', 'peek'];
/** 双击判定窗口，略大于系统的双击间隔感受。 */
const DOUBLE_CLICK_DELAY_MS = 200;

interface ReadingError {
  message: string;
  code?: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function pointFromRatio(state: Pick<PupUiState, 'xRatio' | 'yRatio'>) {
  return {
    x: state.xRatio * Math.max(0, window.innerWidth - DOG_SIZE - VIEWPORT_GAP * 2) + VIEWPORT_GAP,
    y: state.yRatio * Math.max(0, window.innerHeight - DOG_SIZE - VIEWPORT_GAP * 2) + VIEWPORT_GAP,
  };
}

const REMINDER_STATUS_LABELS: Record<ReminderStatus, string> = {
  shown: '已展示',
  dismissed: '已关闭',
  muted: '已静音',
  cooldown: '冷却中忍住',
  deferred: '操作时延迟',
  expired: '已过期',
};

function fallbackCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 回退到选区复制。
  }
  return fallbackCopy(text);
}

function ReminderNotice({ record, onDismiss, onMute }: {
  record: ReminderRecord;
  onDismiss: () => void;
  onMute: () => void;
}) {
  return (
    <article className="pup-reminder-notice" data-testid="active-reminder">
      <div className="pup-reminder-heading">
        <span>{REMINDER_LABELS[record.type]}</span>
        <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={onDismiss} aria-label="关闭本次提醒" title="关闭"><X size={15} /></button>
      </div>
      <p>{record.message}</p>
      <small><strong>为什么现在说：</strong>{record.reason}</small>
      <div className="pup-reminder-actions">
        <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={onDismiss}>知道了</button>
        <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={onMute}><BellOff size={13} /> 以后别提醒此类</button>
      </div>
    </article>
  );
}

export default function PupApp() {
  const [position, setPosition] = useState(() => ({ x: window.innerWidth - DOG_SIZE - 20, y: window.innerHeight - DOG_SIZE - 20 }));
  const [collapsed, setCollapsed] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'reading' | 'history' | 'glossary'>('reading');
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null);
  const [selectionNotice, setSelectionNotice] = useState('');
  const [result, setResult] = useState<ReadingResult | null>(null);
  const [resultScope, setResultScope] = useState<'selection' | 'page'>('selection');
  const [pageSnapshot, setPageSnapshot] = useState<{ text: string; segments: SourceSegment[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<ReadingError | null>(null);
  const [pet, setPet] = useState<PetId>(DEFAULT_SETTINGS.pet);
  const [customName, setCustomName] = useState(DEFAULT_SETTINGS.customName);
  const [customImage, setCustomImage] = useState(DEFAULT_SETTINGS.customImage);
  const [idleNudgesEnabled, setIdleNudgesEnabled] = useState(DEFAULT_SETTINGS.idleNudgesEnabled);
  const [nudge, setNudge] = useState<string | null>(null);
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const [glossaryBubble, setGlossaryBubble] = useState<string | null>(null);
  const [confirmClearGlossary, setConfirmClearGlossary] = useState(false);
  const [lengthMode, setLengthMode] = useState<ReadingLength>('bullets');
  const [copyNote, setCopyNote] = useState('');
  const [dragging, setDragging] = useState(false);
  const [idleAction, setIdleAction] = useState<PetIdleAction>('none');
  const [sleepy, setSleepy] = useState(false);
  const [wakeTick, setWakeTick] = useState(0);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const hoveredRef = useRef(false);
  const clickTimerRef = useRef<number | null>(null);
  const didDragRef = useRef(false);
  const snapshotRef = useRef<SelectionSnapshot | null>(null);
  const activeRequestRef = useRef<{ id: string; selectionText: string } | null>(null);
  const lastRequestRef = useRef<{ operation: ReadingOperation; length: ReadingLength; scope: 'selection' | 'page' } | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const lastNudgeAtRef = useRef(0);
  const interactingRef = useRef(false);
  const highlightCleanupRef = useRef<(() => void) | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const draftRef = useRef('');
  const readPortRef = useRef<chrome.runtime.Port | null>(null);
  const glossaryRef = useRef<GlossaryEntry[]>([]);
  const glossaryHighlightRef = useRef<GlossaryHighlightController | null>(null);
  const glossaryBubbleShownRef = useRef(false);
  const glossaryBubbleTimerRef = useRef<number | null>(null);
  const clearGlossaryTimerRef = useRef<number | null>(null);
  const { records, activeReminder, dismissReminder, muteActiveReminder } = useReminders(
    collapsed || Boolean(snapshot && !panelOpen),
  );

  const updateSnapshot = useCallback((next: SelectionSnapshot | null) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const cancelActiveRequest = useCallback(() => {
    const active = activeRequestRef.current;
    if (!active) return;
    activeRequestRef.current = null;
    setLoading(false);
    draftRef.current = '';
    setDraftText('');
    const port = readPortRef.current;
    readPortRef.current = null;
    try {
      // 断开端口就是取消：后台会在 onDisconnect 里中止对应的 AbortController。
      port?.disconnect();
    } catch {
      // 扩展上下文失效时端口可能已断开。
    }
  }, []);

  useEffect(() => {
    void Promise.all([getUiState(), getSitePosition(window.location.origin)]).then(([state, sitePosition]) => {
      setPosition(pointFromRatio(sitePosition ?? state));
      setCollapsed(state.collapsed);
      setReady(true);
    }).catch(() => setReady(true));
  }, []);

  useEffect(() => {
    let active = true;
    void getSettings().then((settings) => {
      if (!active) return;
      setPet(settings.pet);
      setCustomName(settings.customName);
      setCustomImage(settings.customImage);
      setIdleNudgesEnabled(settings.idleNudgesEnabled);
    }).catch(() => undefined);

    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      const settingsChange = changes[SETTINGS_KEY]?.newValue;
      if (settingsChange) {
        const next = settingsChange as { pet?: PetId; idleNudgesEnabled?: boolean; customName?: string; customImage?: string };
        if (next.pet) setPet(next.pet);
        if (typeof next.customName === 'string') setCustomName(next.customName);
        if (typeof next.customImage === 'string') setCustomImage(next.customImage);
        if (typeof next.idleNudgesEnabled === 'boolean') setIdleNudgesEnabled(next.idleNudgesEnabled);
      }
      const glossaryChange = changes[GLOSSARY_KEY]?.newValue;
      if (Array.isArray(glossaryChange)) {
        const entries = glossaryChange as GlossaryEntry[];
        glossaryRef.current = entries;
        setGlossary(entries);
        glossaryHighlightRef.current?.refresh();
      }
    };
    try {
      chrome.storage.onChanged.addListener(onChanged);
    } catch {
      // 扩展上下文失效时忽略。
    }
    return () => {
      active = false;
      try {
        chrome.storage.onChanged.removeListener(onChanged);
      } catch {
        // 扩展上下文失效时忽略。
      }
    };
  }, []);

  useEffect(() => {
    let active = true;
    const controller = createGlossaryHighlight({
      getEntries: () => glossaryRef.current,
      onDelete: (id) => {
        // 删除后 storage.onChanged 会同步状态并触发重新扫描。
        void deleteGlossaryEntry(id).catch(() => undefined);
      },
      onScanComplete: (uniqueTerms) => {
        if (uniqueTerms < 3 || glossaryBubbleShownRef.current) return;
        glossaryBubbleShownRef.current = true;
        setGlossaryBubble(`这一页有 ${uniqueTerms} 个术语我认识，已经帮你标出来了。`);
        if (glossaryBubbleTimerRef.current) window.clearTimeout(glossaryBubbleTimerRef.current);
        glossaryBubbleTimerRef.current = window.setTimeout(() => setGlossaryBubble(null), 8000);
      },
    });
    glossaryHighlightRef.current = controller;
    void getGlossary().then((entries) => {
      if (!active) return;
      glossaryRef.current = entries;
      setGlossary(entries);
      controller.refresh();
    }).catch(() => undefined);
    return () => {
      active = false;
      glossaryHighlightRef.current = null;
      controller.destroy();
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      setPosition((current) => ({
        x: clamp(current.x, VIEWPORT_GAP, Math.max(VIEWPORT_GAP, window.innerWidth - DOG_SIZE - VIEWPORT_GAP)),
        y: clamp(current.y, VIEWPORT_GAP, Math.max(VIEWPORT_GAP, window.innerHeight - DOG_SIZE - VIEWPORT_GAP)),
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const quiet = !idleNudgesEnabled || collapsed || panelOpen || Boolean(snapshot) || loading || Boolean(activeReminder);
    if (quiet) {
      setNudge(null);
      return;
    }
    let showTimer = 0;
    let hideTimer = 0;
    let lastResetAt = 0;
    const scheduleNext = () => {
      window.clearTimeout(showTimer);
      const wait = Math.max(nudgeDelayMs(), NUDGE_GAP_MS - (Date.now() - lastNudgeAtRef.current));
      showTimer = window.setTimeout(() => {
        lastNudgeAtRef.current = Date.now();
        setNudge(pickNudge());
        hideTimer = window.setTimeout(() => setNudge(null), 8000);
      }, wait);
    };
    const onActivity = () => {
      const now = Date.now();
      if (now - lastResetAt < 2000) return;
      lastResetAt = now;
      setNudge(null);
      window.clearTimeout(hideTimer);
      scheduleNext();
    };
    const onVisibilityChange = () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      setNudge(null);
      if (document.visibilityState === 'visible') {
        lastResetAt = Date.now();
        scheduleNext();
      }
    };
    scheduleNext();
    window.addEventListener('pointerdown', onActivity, { passive: true });
    window.addEventListener('keydown', onActivity, true);
    window.addEventListener('scroll', onActivity, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity, true);
      window.removeEventListener('scroll', onActivity);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [idleNudgesEnabled, collapsed, panelOpen, snapshot, loading, activeReminder]);

  // 待机小动作：30~90 秒随机挑一个，拖拽、思考或打开面板时暂停。
  useEffect(() => {
    if (dragging || loading || panelOpen || snapshot) {
      setIdleAction('none');
      return;
    }
    let active = true;
    let nextTimer = 0;
    let holdTimer = 0;
    const schedule = () => {
      nextTimer = window.setTimeout(() => {
        if (!active) return;
        setIdleAction(IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)] ?? 'tilt');
        holdTimer = window.setTimeout(() => {
          if (!active) return;
          setIdleAction('none');
          schedule();
        }, IDLE_ACTION_HOLD_MS);
      }, IDLE_ACTION_MIN_MS + Math.random() * IDLE_ACTION_RANGE_MS);
    };
    schedule();
    return () => {
      active = false;
      window.clearTimeout(nextTimer);
      window.clearTimeout(holdTimer);
    };
  }, [dragging, loading, panelOpen, snapshot]);

  // 闲置休眠：2 分钟没碰它就缩小变淡，指针移上去立刻醒来（wakeTick 用来重新计时）。
  useEffect(() => {
    if (panelOpen || loading || dragging || snapshot || activeReminder) return;
    let active = true;
    let timer = 0;
    const arm = () => {
      timer = window.setTimeout(() => {
        if (!active) return;
        if (hoveredRef.current || document.visibilityState !== 'visible') {
          arm();
          return;
        }
        setSleepy(true);
      }, SLEEP_AFTER_MS);
    };
    arm();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [panelOpen, loading, dragging, snapshot, activeReminder, wakeTick]);

  useEffect(() => {
    if (!loading) {
      setElapsedSeconds(0);
      return;
    }
    const start = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loading]);

  useEffect(() => {
    let timer = 0;
    const onSelectionChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const capture = captureSelection(window.getSelection());
        if (capture.rejection === 'empty' && interactingRef.current) return;
        const next = capture.snapshot ?? null;
        if (next?.text === snapshotRef.current?.text) return;

        cancelActiveRequest();
        highlightCleanupRef.current?.();
        highlightCleanupRef.current = null;
        if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
        updateSnapshot(next);
        setResult(null);
        setError(null);
        if (next) {
          setSelectionNotice('');
        } else if (capture.rejection === 'too-long') {
          setSelectionNotice(`选区超过 ${MAX_SELECTION_CHARACTERS} 字，请缩小范围后再试。`);
        } else if (capture.rejection === 'too-many-segments') {
          setSelectionNotice(`一次最多阅读 ${MAX_SELECTION_SEGMENTS} 段，请减少所选段落。`);
        } else {
          setSelectionNotice('');
        }
      }, 120);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [cancelActiveRequest, updateSnapshot]);

  useEffect(() => () => {
    cancelActiveRequest();
    highlightCleanupRef.current?.();
    if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    if (glossaryBubbleTimerRef.current) window.clearTimeout(glossaryBubbleTimerRef.current);
    if (clearGlossaryTimerRef.current) window.clearTimeout(clearGlossaryTimerRef.current);
    if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current);
  }, [cancelActiveRequest]);

  const persist = useCallback((point: { x: number; y: number }, nextCollapsed = collapsed) => {
    const maxX = Math.max(1, window.innerWidth - DOG_SIZE - VIEWPORT_GAP * 2);
    const maxY = Math.max(1, window.innerHeight - DOG_SIZE - VIEWPORT_GAP * 2);
    const ratios = {
      xRatio: clamp((point.x - VIEWPORT_GAP) / maxX, 0, 1),
      yRatio: clamp((point.y - VIEWPORT_GAP) / maxY, 0, 1),
    };
    void saveUiState({ ...ratios, collapsed: nextCollapsed }).catch(() => undefined);
    void saveSitePosition(window.location.origin, ratios).catch(() => undefined);
  }, [collapsed]);

  const wakeUp = useCallback(() => {
    setSleepy(false);
    setWakeTick((tick) => tick + 1);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (event.currentTarget.tagName !== 'BUTTON' && (event.target as Element).closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    didDragRef.current = false;
    wakeUp();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 5) {
      didDragRef.current = true;
      setDragging(true);
    }
    // 拖拽时限制在视口内，松开后位置原样保留。
    const maxX = Math.max(VIEWPORT_GAP, window.innerWidth - DOG_SIZE - VIEWPORT_GAP);
    const maxY = Math.max(VIEWPORT_GAP, window.innerHeight - DOG_SIZE - VIEWPORT_GAP);
    setPosition({
      x: clamp(drag.originX + deltaX, VIEWPORT_GAP, maxX),
      y: clamp(drag.originY + deltaY, VIEWPORT_GAP, maxY),
    });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    setPosition((current) => {
      persist(current);
      return current;
    });
  };

  const openOptions = () => {
    void sendRuntimeMessage({ type: 'page-pup:open-options' }).catch(() => undefined);
  };

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    setPanelOpen(false);
    persist(position, next);
  };

  const onAvatarClick = () => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    // 单击延迟 200ms 执行，用来让位给「双击切换收起/展开」。
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      toggleCollapsed();
      return;
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      if (collapsed) {
        setCollapsed(false);
        persist(position, false);
        setPanelOpen(true);
      } else {
        setPanelOpen((open) => !open);
      }
    }, DOUBLE_CLICK_DELAY_MS);
  };

  const executeReading = async (
    selected: { text: string; segments: SourceSegment[] },
    operation: ReadingOperation,
    length: ReadingLength,
    scope: 'selection' | 'page',
  ) => {
    cancelActiveRequest();
    const requestId = crypto.randomUUID();
    if (scope === 'page') setPageSnapshot(selected);
    activeRequestRef.current = { id: requestId, selectionText: selected.text };
    lastRequestRef.current = { operation, length, scope };
    setLoading(true);
    setResult(null);
    setError(null);
    setCopyNote('');
    draftRef.current = '';
    setDraftText('');
    setPanelOpen(true);
    setActiveTab('reading');
    if (collapsed) {
      setCollapsed(false);
      persist(position, false);
    }

    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: READ_PORT_NAME });
    } catch {
      // 扩展刚更新或重新加载时 connect 会直接抛错。
      activeRequestRef.current = null;
      setLoading(false);
      setError({ message: '扩展刚刚更新或重新加载，请刷新此页面后再试' });
      return;
    }
    readPortRef.current = port;

    const settle = () => {
      if (readPortRef.current === port) readPortRef.current = null;
      try {
        port.disconnect();
      } catch {
        // 端口已断开时忽略。
      }
    };

    port.onMessage.addListener((message: unknown) => {
      if (!isReadPortResponse(message) || message.requestId !== requestId) return;
      if (activeRequestRef.current?.id !== requestId) {
        settle();
        return;
      }
      if (message.type === 'delta') {
        if (draftRef.current.length < 8000) {
          draftRef.current += message.text;
          setDraftText(draftRef.current);
        }
      } else if (message.type === 'done') {
        activeRequestRef.current = null;
        setLoading(false);
        draftRef.current = '';
        setDraftText('');
        setResult(message.result);
        setResultScope(scope);
        settle();
      } else {
        activeRequestRef.current = null;
        setLoading(false);
        draftRef.current = '';
        setDraftText('');
        setError({ message: message.error, code: message.code });
        settle();
      }
    });
    port.onDisconnect.addListener(() => {
      settle();
      if (activeRequestRef.current?.id !== requestId) return;
      activeRequestRef.current = null;
      setLoading(false);
      draftRef.current = '';
      setDraftText('');
      setError(extensionAlive()
        ? { message: '阅读连接中断，请重试' }
        : { message: '扩展刚刚更新或重新加载，请刷新此页面后再试' });
    });
    port.postMessage({
      type: 'read',
      requestId,
      operation,
      length,
      scope,
      sources: selected.segments.map(({ id, text }) => ({ id, text })),
    });
  };

  const runReading = async (operation: ReadingOperation) => {
    const immediate = captureSelection(window.getSelection());
    const selected = immediate.snapshot ?? (
      immediate.rejection === 'empty' && interactingRef.current ? snapshotRef.current : null
    );
    if (!selected) return;
    if (immediate.snapshot) {
      if (immediate.snapshot.text !== snapshotRef.current?.text) {
        highlightCleanupRef.current?.();
        highlightCleanupRef.current = null;
        if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
      }
      updateSnapshot(immediate.snapshot);
      setSelectionNotice('');
    }
    await executeReading(selected, operation, lengthMode, 'selection');
  };

  const summarizePage = async () => {
    const page = extractPageSnapshot(document);
    if (!page) {
      setSelectionNotice('这一页没有足够的正文可以总结。');
      return;
    }
    setSelectionNotice('');
    await executeReading(page, 'summarize', lengthMode, 'page');
  };

  const retryReading = () => {
    const last = lastRequestRef.current;
    if (!last) return;
    const source = last.scope === 'page' ? pageSnapshot : snapshotRef.current;
    if (!source) return;
    void executeReading(source, last.operation, last.length, last.scope);
  };

  const displayName = pupDisplayName({ customName });
  const collectedTerms = new Set(glossary.map((entry) => entry.term));

  const resultHeading = result?.operation === 'explain'
    ? '这段的意思'
    : result?.operation === 'translate'
      ? '这段的翻译'
      : resultScope === 'page'
        ? '整页要点'
        : '压缩后的要点';

  const markdownResult = () => {
    if (!result || result.status !== 'ok') return '';
    const evidence = result.items.map((item) => {
      const quotes = item.evidenceIds
        .map((id) => result.sources.find((source) => source.id === id)?.text)
        .filter(Boolean)
        .map((quote) => `  > ${quote!.replace(/\n/g, '\n  > ')}`);
      return [
        `- ${item.text}（依据 ${item.evidenceIds.join('、')}）`,
        ...quotes,
      ].join('\n');
    });
    return [
      `# ${resultHeading}`,
      '',
      `> 来源：${document.title.trim() || '当前页面'} · ${window.location.href}`,
      '',
      ...evidence,
    ].join('\n');
  };

  const exportResult = () => {
    const markdown = markdownResult();
    if (!markdown) return;
    const stamp = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const safeTitle = (document.title.trim() || '当前页面').replace(/[\\/:*?"<>|]/g, '-').slice(0, 30);
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `伴读笔记-${safeTitle}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setCopyNote('已导出 Markdown 文件');
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyNote(''), 1800);
  };

  const copyResult = async (format: 'text' | 'markdown') => {
    if (!result || result.status !== 'ok') return;
    const text = format === 'text'
      ? result.items.map((item) => item.text).join('\n')
      : markdownResult();
    const copied = await copyText(text);
    setCopyNote(copied ? '已复制到剪贴板' : '复制失败，请手动选择文字');
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyNote(''), 1800);
  };

  const locateSource = (id: string) => {
    const selected = snapshotRef.current;
    const index = selected?.segments.findIndex((segment) => segment.id === id) ?? -1;
    const range = index >= 0 ? selected?.ranges[index] : null;
    if (!range) return;
    highlightCleanupRef.current?.();
    if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    highlightCleanupRef.current = highlightSourceRange(range);
    highlightTimerRef.current = window.setTimeout(() => {
      highlightCleanupRef.current?.();
      highlightCleanupRef.current = null;
    }, 2200);
  };

  const notifyCopyNote = (note: string) => {
    setCopyNote(note);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyNote(''), 1800);
  };

  const glossaryInputFromItem = (item: ReadingItem): { term: string; definition: string; sourceOrigin: string } | null => {
    const source = result?.sources.find((segment) => segment.id === item.evidenceIds[0]);
    if (!source) return null;
    return {
      term: source.text,
      definition: item.text,
      sourceOrigin: window.location.origin,
    };
  };

  const collectGlossaryItem = async (item: ReadingItem) => {
    const input = glossaryInputFromItem(item);
    if (!input) return;
    try {
      await saveGlossaryEntries([input]);
      notifyCopyNote('已收进术语本');
    } catch (error) {
      notifyCopyNote(error instanceof Error ? error.message : '术语保存失败');
    }
  };

  const collectAllGlossaryItems = async () => {
    if (!result || result.status !== 'ok') return;
    const inputs = result.items
      .map((item) => glossaryInputFromItem(item))
      .filter((input): input is { term: string; definition: string; sourceOrigin: string } => Boolean(input));
    if (!inputs.length) return;
    try {
      await saveGlossaryEntries(inputs);
      notifyCopyNote(`已把 ${inputs.length} 条收进术语本`);
    } catch (error) {
      notifyCopyNote(error instanceof Error ? error.message : '术语保存失败');
    }
  };

  const removeGlossaryEntry = async (id: string) => {
    // 删除后由 storage.onChanged 统一同步列表并重新扫描高亮。
    void deleteGlossaryEntry(id).catch(() => undefined);
  };

  const onClearGlossary = () => {
    if (!confirmClearGlossary) {
      setConfirmClearGlossary(true);
      if (clearGlossaryTimerRef.current) window.clearTimeout(clearGlossaryTimerRef.current);
      clearGlossaryTimerRef.current = window.setTimeout(() => setConfirmClearGlossary(false), 3500);
      return;
    }
    if (clearGlossaryTimerRef.current) window.clearTimeout(clearGlossaryTimerRef.current);
    setConfirmClearGlossary(false);
    void clearGlossary().catch(() => undefined);
  };

  const nearRight = position.x > window.innerWidth / 2;
  const nearBottom = position.y > window.innerHeight / 2;
  const directionClasses = `${nearRight ? 'opens-left' : 'opens-right'} ${nearBottom ? 'opens-up' : 'opens-down'}`;
  const availablePanelHeight = nearBottom
    ? position.y - 12 - VIEWPORT_GAP
    : window.innerHeight - position.y - 78 - VIEWPORT_GAP;
  const panelMaxHeight = Math.min(600, Math.max(0, availablePanelHeight));
  const preserveSelection = (event: React.PointerEvent<HTMLButtonElement>) => event.preventDefault();
  const anchorStyle = {
    transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
  } as React.CSSProperties;

  const readingActions = (
    <div className="pup-reading-actions">
      <button type="button" className="pup-primary-action" disabled={loading} onPointerDown={preserveSelection} onClick={() => void runReading('explain')}>
        <BookOpenText size={15} /> 解释这段
      </button>
      <button type="button" className="pup-secondary-action" disabled={loading} onPointerDown={preserveSelection} onClick={() => void runReading('summarize')}>
        <ListOrdered size={15} /> 压成要点
      </button>
      <button type="button" className="pup-secondary-action pup-translate-action" disabled={loading} onPointerDown={preserveSelection} onClick={() => void runReading('translate')}>
        <Languages size={15} /> 翻译 / 术语解释
      </button>
    </div>
  );

  const lengthSwitch = (
    <div className="pup-length-switch" role="group" aria-label="摘要长度">
      {(['one', 'three', 'bullets'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={lengthMode === mode}
          className={lengthMode === mode ? 'is-active' : ''}
          onPointerDown={preserveSelection}
          onClick={() => setLengthMode(mode)}
        >
          {READING_LENGTH_LABELS[mode]}
        </button>
      ))}
    </div>
  );

  return (
    <div
      className={`pup-anchor ${ready ? 'is-ready' : ''} ${dragging ? 'is-dragging' : ''}`}
      style={anchorStyle}
      data-testid="page-pup"
      onPointerDownCapture={() => { interactingRef.current = true; }}
      onPointerUpCapture={() => window.setTimeout(() => { interactingRef.current = false; }, 250)}
      onPointerCancelCapture={() => { interactingRef.current = false; }}
    >
      {snapshot && !panelOpen && !collapsed && (
        <div className={`pup-quick-actions ${directionClasses}`} aria-label="选区阅读操作">
          <span>已选 {snapshot.segments.length} 段</span>
          {lengthSwitch}
          {readingActions}
        </div>
      )}

      {activeReminder && !panelOpen && !collapsed && !snapshot && (
        <div className={`pup-reminder-floating ${directionClasses}`}>
          <ReminderNotice record={activeReminder} onDismiss={dismissReminder} onMute={muteActiveReminder} />
        </div>
      )}

      {nudge && !panelOpen && !collapsed && !snapshot && !activeReminder && !glossaryBubble && (
        <div className={`pup-nudge ${directionClasses}`} role="status">
          <span>{nudge}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNudge(null)}><X size={12} /></button>
        </div>
      )}

      {glossaryBubble && !panelOpen && !collapsed && !snapshot && !activeReminder && !nudge && (
        <div className={`pup-nudge pup-nudge-glossary ${directionClasses}`} role="status" data-testid="glossary-nudge">
          <span>{glossaryBubble}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setGlossaryBubble(null)}><X size={12} /></button>
        </div>
      )}

      {panelOpen && !collapsed && (
        <section className={`pup-panel ${directionClasses}`} aria-label={`${displayName}面板`} style={{ maxHeight: panelMaxHeight }}>
          <header
            className="pup-panel-header"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <div className="pup-panel-brand">
              <span className="pup-mini-avatar"><Pet pet={pet} customImage={customImage} compact attentive={Boolean(snapshot)} thinking={loading} /></span>
              <div><strong>{displayName}</strong><span>只读你选中的内容</span></div>
            </div>
            <div className="pup-header-actions">
              <button type="button" className="pup-icon-button" onClick={openOptions} aria-label="打开设置" title="设置"><Settings2 size={17} /></button>
              <button type="button" className="pup-icon-button" onClick={toggleCollapsed} aria-label="收起小狗" title="收起"><Minus size={18} /></button>
            </div>
          </header>

          <nav className="pup-tabs" aria-label="面板功能">
            <button type="button" className={activeTab === 'reading' ? 'is-active' : ''} onClick={() => setActiveTab('reading')}><BookOpenText size={15} /> 阅读</button>
            <button type="button" className={activeTab === 'glossary' ? 'is-active' : ''} onClick={() => setActiveTab('glossary')}><BookMarked size={15} /> 术语本{glossary.length > 0 && <span className="pup-tab-count">{glossary.length}</span>}</button>
            <button type="button" className={activeTab === 'history' ? 'is-active' : ''} onClick={() => setActiveTab('history')}><History size={15} /> 提醒记录</button>
          </nav>

          <div className="pup-panel-body">
            {activeReminder && (
              <ReminderNotice record={activeReminder} onDismiss={dismissReminder} onMute={muteActiveReminder} />
            )}
            {activeTab === 'history' ? (
              records.length === 0 ? (
                <div className="pup-empty pup-history-empty"><History size={24} /><h2>还没有提醒记录</h2><p>已展示和被忍住的提醒都会留在这里。</p></div>
              ) : (
                <div className="pup-history-list">
                  <div className="pup-history-intro"><strong>本地提醒记录</strong><span>最近 {records.length} 条 · 最多 100 条</span></div>
                  {records.map((record) => (
                    <article className="pup-history-record" data-testid="reminder-record" key={record.id}>
                      <div className="pup-history-record-heading">
                        <strong>{REMINDER_LABELS[record.type]}</strong>
                        <time>{new Date(record.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
                      </div>
                      <p>{record.message}</p>
                      <small>{record.reason}</small>
                      <div className="pup-history-status">
                        <span className={`is-${record.status}`}>{REMINDER_STATUS_LABELS[record.status]}</span>
                        {record.suppressionReason && <small>{record.suppressionReason}</small>}
                      </div>
                    </article>
                  ))}
                </div>
              )
            ) : activeTab === 'glossary' ? (
              glossary.length === 0 ? (
                <div className="pup-empty pup-glossary-empty"><BookMarked size={24} /><h2>术语本还是空的</h2><p>阅读结果里点「收进术语本」，之后我会在启用站点帮你标出这些词。</p></div>
              ) : (
                <div className="pup-glossary-list">
                  <div className="pup-history-intro"><strong>本地术语本</strong><span>{glossary.length} 条 · 最多 {GLOSSARY_MAX_ENTRIES} 条</span></div>
                  {glossary.map((entry) => (
                    <article className="pup-glossary-entry" data-testid="glossary-entry" key={entry.id}>
                      <div className="pup-glossary-heading">
                        <strong>{entry.term}</strong>
                        <div>
                          <time>{new Date(entry.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric' })}</time>
                          <button type="button" aria-label={`删除术语 ${entry.term}`} title="删除" onClick={() => void removeGlossaryEntry(entry.id)}><Trash2 size={13} /></button>
                        </div>
                      </div>
                      <p>{entry.definition}</p>
                      {entry.sourceOrigin && <small>来自 {entry.sourceOrigin}</small>}
                    </article>
                  ))}
                  <button type="button" className={`pup-glossary-clear ${confirmClearGlossary ? 'is-confirm' : ''}`} onClick={onClearGlossary}>
                    <Trash2 size={13} /> {confirmClearGlossary ? '确认清空全部术语？' : '清空术语本'}
                  </button>
                </div>
              )
            ) : (
              <>
                <div className="pup-page-action">
                  <button type="button" disabled={loading} onClick={() => void summarizePage()}>
                    <ListOrdered size={13} /> 总结整页
                  </button>
                  <span>只读当前页正文（最多前 4500 字），不保存</span>
                </div>
                {selectionNotice && <div className="pup-selection-notice" role="status">{selectionNotice}</div>}

                {!snapshot && !selectionNotice && !result && !loading && !error && (
                  <div className="pup-empty">
                    <span className="pup-empty-mark">Aa</span><h2>选中想读懂的文字</h2>
                    <p>我可以解释意思或压成要点，每条理解都会附上原文依据。</p>
                    <div className="pup-privacy-line">整页总结只在你点击时读取正文 · 不保存页面内容</div>
                  </div>
                )}

                {snapshot && (
                  <div className="pup-selection-card">
                    <div className="pup-selection-meta"><span>当前选区</span><small>{snapshot.segments.length} 段 · {snapshot.text.length} 字</small></div>
                    <p>{snapshot.text}</p>
                    {lengthSwitch}
                    {readingActions}
                  </div>
                )}

                {loading && (
                  <div className="pup-loading" role="status">
                    <LoaderCircle size={18} />
                    <div>
                      <strong>{lastRequestRef.current?.scope === 'page' ? '正在总结整页正文' : '正在逐字思考'}</strong>
                      {draftText ? (
                        <>
                          <ul className="pup-draft-list" data-testid="reading-draft" aria-label="流式草稿">
                            {draftItemsFromStream(draftText).map((text, index, all) => (
                              <li key={index}>{text}{index === all.length - 1 && <span className="pup-draft-cursor" aria-hidden="true" />}</li>
                            ))}
                          </ul>
                          <p className="pup-loading-meta">低透明度草稿 ·{lastRequestRef.current?.scope === 'page' ? ` 已等待 ${elapsedSeconds} 秒，最多 120 秒` : ' 结束后给出带依据的正式结果'}</p>
                        </>
                      ) : (
                        <p>{lastRequestRef.current?.scope === 'page' ? `已等待 ${elapsedSeconds} 秒，最多 120 秒，可随时取消` : '不会发送网址或页面其他内容'}</p>
                      )}
                    </div>
                    <button type="button" onClick={cancelActiveRequest} aria-label="取消阅读"><X size={15} /></button>
                  </div>
                )}

                {error && !loading && (
                  <div className="pup-error" role="alert">
                    <strong>这次没有读懂</strong><p>{error.message}</p>
                    <div className="pup-error-actions">
                      {snapshotRef.current && lastRequestRef.current && (
                        <button type="button" onClick={retryReading}>重试</button>
                      )}
                      {(error.code === 'NO_KEY' || error.code === 'API_PERMISSION' || error.code === 'INVALID_CONFIG') && <button type="button" onClick={openOptions}>打开设置</button>}
                    </div>
                  </div>
                )}

                {result && !loading && (
                  <div className="pup-result" data-testid="reading-result">
                    <div className="pup-result-heading">
                      <span>{resultHeading}</span>
                      <div className="pup-result-tools">
                        <button type="button" onClick={() => void copyResult('text')}>复制</button>
                        <button type="button" onClick={() => void copyResult('markdown')}>Markdown</button>
                        <button type="button" onClick={exportResult}><Download size={12} /> 导出</button>
                        <button type="button" onClick={retryReading}>重试</button>
                        {result.operation === 'translate' && result.status === 'ok' && (
                          <button type="button" className="pup-collect-all" onClick={() => void collectAllGlossaryItems()}><BookmarkPlus size={12} /> 全部收进术语本</button>
                        )}
                      </div>
                    </div>
                    {copyNote && <div className="pup-copy-note" role="status">{copyNote}</div>}
                    {result.status === 'insufficient' ? (
                      <div className="pup-insufficient"><strong>原文不足，我不知道。</strong><p>可以换选包含更多上下文的文字，我不会补写原文之外的结论。</p></div>
                    ) : result.items.map((item, itemIndex) => {
                      const source = result.sources.find((segment) => segment.id === item.evidenceIds[0]);
                      const collected = source ? collectedTerms.has(normalizeGlossaryTerm(source.text)) : false;
                      return (
                        <article className="pup-reading-item" key={`${item.text}-${itemIndex}`}>
                          <p>{item.text}</p>
                          {source && (
                            <div className="pup-item-actions">
                              <button
                                type="button"
                                className={collected ? 'is-collected' : ''}
                                disabled={collected}
                                onClick={() => void collectGlossaryItem(item)}
                              >
                                <BookmarkPlus size={12} /> {collected ? '已在术语本' : '收进术语本'}
                              </button>
                            </div>
                          )}
                          <div className="pup-evidence-list">
                            {item.evidenceIds.map((id) => {
                              const evidenceSource = result.sources.find((segment) => segment.id === id);
                              if (!evidenceSource) return null;
                              return (
                                <div className="pup-evidence" key={id}>
                                  {resultScope === 'selection'
                                    ? <button type="button" onClick={() => locateSource(id)}><LocateFixed size={13} /> 依据 {id} · 定位原文</button>
                                    : <span className="pup-evidence-label">依据 {id}</span>}
                                  <blockquote>{evidenceSource.text.length > 140 ? `${evidenceSource.text.slice(0, 140)}…` : evidenceSource.text}</blockquote>
                                </div>
                              );
                            })}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      )}

      <button
        type="button"
        className={`pup-avatar-button ${collapsed ? 'is-collapsed' : ''} ${panelOpen ? 'is-open' : ''} ${dragging ? 'is-dragging' : ''} ${sleepy ? 'is-sleepy' : ''}`}
        aria-label={collapsed ? `展开${displayName}` : panelOpen ? `关闭${displayName}面板` : `打开${displayName}`}
        title={`${displayName} · 可拖动，双击收起/展开`}
        data-testid="pup-avatar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={() => {
          hoveredRef.current = true;
          if (sleepy) wakeUp();
        }}
        onPointerLeave={() => { hoveredRef.current = false; }}
        onClick={onAvatarClick}
      >
        <Pet
          pet={pet}
          customImage={customImage}
          compact={collapsed}
          attentive={Boolean(snapshot)}
          thinking={loading}
          action={sleepy || collapsed ? 'none' : idleAction}
        />
        {sleepy && !panelOpen && <span className="pup-zzz" aria-hidden="true">Zzz</span>}
        {!collapsed && <span className={`pup-status-dot ${snapshot ? 'is-attentive' : ''}`} aria-hidden="true" />}
      </button>
    </div>
  );
}
