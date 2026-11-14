import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createReadingActivity,
  createReminderCandidate,
  decideReminder,
  readingReminderDue,
  recordReadingScroll,
  REMINDER_TIMING,
  sampleReadingActivity,
  type ReminderCandidate,
} from '../../shared/reminders';
import { getReminderRecords, getSettings, saveReminderRecord, saveSettings } from '../../shared/storage';
import { DEFAULT_SETTINGS, type PupSettings, type ReminderRecord, type ReminderType } from '../../shared/types';

function trackableFormTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target.closest('[data-page-pup-private]')) return false;
  if (target instanceof HTMLInputElement && target.type === 'password') return false;
  return target.matches('input, textarea, select');
}

export function useReminders(paused: boolean) {
  const [records, setRecords] = useState<ReminderRecord[]>([]);
  const [activeReminder, setActiveReminder] = useState<ReminderRecord | null>(null);
  const [settings, setSettings] = useState<PupSettings | null>(null);
  const settingsRef = useRef<PupSettings>(DEFAULT_SETTINGS);
  const activeReminderRef = useRef<ReminderRecord | null>(null);
  const pausedRef = useRef(paused);
  const mountedRef = useRef(false);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const updateActiveReminder = useCallback((record: ReminderRecord | null) => {
    activeReminderRef.current = record;
    setActiveReminder(record);
  }, []);

  const persistRecord = useCallback((record: ReminderRecord) => {
    writeQueueRef.current = writeQueueRef.current.then(async () => {
      const next = await saveReminderRecord(record);
      if (mountedRef.current) setRecords(next);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    void Promise.all([getSettings(), getReminderRecords()]).then(([storedSettings, storedRecords]) => {
      if (disposed) return;
      settingsRef.current = storedSettings;
      setSettings(storedSettings);
      setRecords(storedRecords);
    }).catch(() => {
      if (!disposed) setSettings(DEFAULT_SETTINGS);
    });

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      const settingsChange = changes['pagePup.settings'];
      if (settingsChange) {
        const next = {
          ...DEFAULT_SETTINGS,
          ...(settingsChange.newValue as Partial<PupSettings> | undefined),
        };
        settingsRef.current = next;
        setSettings(next);
      }
      const recordsChange = changes['pagePup.reminders'];
      if (recordsChange) {
        setRecords(Array.isArray(recordsChange.newValue) ? recordsChange.newValue as ReminderRecord[] : []);
      }
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => {
      disposed = true;
      mountedRef.current = false;
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  useEffect(() => {
    pausedRef.current = paused;
    if (paused) updateActiveReminder(null);
  }, [paused, updateActiveReminder]);

  useEffect(() => {
    if (!activeReminder) return;
    const timer = window.setTimeout(() => {
      if (activeReminderRef.current?.id === activeReminder.id) updateActiveReminder(null);
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [activeReminder, updateActiveReminder]);

  const dismissReminder = useCallback(() => {
    const current = activeReminderRef.current;
    if (!current) return;
    updateActiveReminder(null);
    persistRecord({ ...current, status: 'dismissed', suppressionReason: undefined });
  }, [persistRecord, updateActiveReminder]);

  const muteActiveReminder = useCallback(() => {
    const current = activeReminderRef.current;
    if (!current) return;
    const currentSettings = settingsRef.current;
    const nextSettings: PupSettings = {
      ...currentSettings,
      mutedReminders: Array.from(new Set([...currentSettings.mutedReminders, current.type])),
    };
    settingsRef.current = nextSettings;
    setSettings(nextSettings);
    updateActiveReminder(null);
    persistRecord({
      ...current,
      status: 'muted',
      suppressionReason: '你在此条提醒上永久静音了此类提醒，可在设置中恢复。',
    });
    void saveSettings(nextSettings).catch(() => undefined);
  }, [persistRecord, updateActiveReminder]);

  const remindersEnabled = settings?.remindersEnabled ?? false;
  useEffect(() => {
    if (!remindersEnabled) return;

    const lastDecisionAt: Partial<Record<ReminderType, number>> = {};
    const pending = new Map<string, ReminderCandidate>();
    const reading = createReadingActivity(Date.now(), window.scrollY, document.visibilityState === 'visible');
    let lastInteractionAt = Number.NEGATIVE_INFINITY;
    let lastOperationAt = Number.NEGATIVE_INFINITY;
    let lastErrorCandidateAt = Number.NEGATIVE_INFINITY;
    let formInputEvents = 0;
    let formTimer = 0;
    let breakVisibleMs = 0;

    const processCandidate = (candidate: ReminderCandidate) => {
      const now = Date.now();
      const decision = decideReminder(candidate, {
        settings: settingsRef.current,
        now,
        busy: pausedRef.current ||
          now - lastInteractionAt < REMINDER_TIMING.interactionDelayMs ||
          activeReminderRef.current !== null,
        alreadyDeferred: pending.has(candidate.id),
        lastDecisionAt: lastDecisionAt[candidate.type],
      });
      if (decision.deferred) pending.set(candidate.id, candidate);
      else pending.delete(candidate.id);
      if (decision.applyCooldown) lastDecisionAt[candidate.type] = now;
      if (decision.record) persistRecord(decision.record);
      if (decision.show && decision.record) updateActiveReminder(decision.record);
    };

    const emitReadingIfDue = () => {
      if (!readingReminderDue(reading, (settingsRef.current.readingThresholdMinutes ?? 8) * 60000)) return;
      reading.emitted = true;
      processCandidate(createReminderCandidate('reading', Date.now(), {
        activeMinutes: Math.floor(reading.visibleMs / 60000),
        scrollReversals: reading.scrollReversals,
      }));
    };

    const sampleVisible = (now: number) => {
      const before = reading.visibleMs;
      sampleReadingActivity(reading, now, document.visibilityState === 'visible');
      const current = settingsRef.current;
      if (!current.breakReminderEnabled) {
        breakVisibleMs = 0;
        return;
      }
      breakVisibleMs += reading.visibleMs - before;
      const intervalMs = current.breakReminderMinutes * 60000;
      if (breakVisibleMs < intervalMs) return;
      breakVisibleMs = 0;
      processCandidate(createReminderCandidate('break', now, {
        breakMinutes: current.breakReminderMinutes,
      }));
    };

    const onScroll = () => {
      lastInteractionAt = Date.now();
      sampleVisible(lastInteractionAt);
      recordReadingScroll(reading, window.scrollY);
      emitReadingIfDue();
    };
    const onVisibilityChange = () => {
      sampleVisible(Date.now());
    };
    const onOperation = () => {
      lastOperationAt = Date.now();
      lastInteractionAt = lastOperationAt;
    };
    const onInput = (event: Event) => {
      lastInteractionAt = Date.now();
      if (!trackableFormTarget(event.target)) return;
      formInputEvents += 1;
      window.clearTimeout(formTimer);
      formTimer = window.setTimeout(() => {
        if (formInputEvents >= 2) {
          processCandidate(createReminderCandidate('form', Date.now(), {
            idleSeconds: Math.round(REMINDER_TIMING.formIdleMs / 1000),
          }));
        }
        formInputEvents = 0;
      }, REMINDER_TIMING.formIdleMs);
    };
    const onPageError = () => {
      const now = Date.now();
      if (now - lastOperationAt > REMINDER_TIMING.errorWindowMs) return;
      if (now - lastErrorCandidateAt < REMINDER_TIMING.errorCandidateIntervalMs) return;
      lastErrorCandidateAt = now;
      processCandidate(createReminderCandidate('error', now, {
        errorWindowSeconds: Math.round(REMINDER_TIMING.errorWindowMs / 1000),
      }));
    };
    const setErrorMonitoring = (enabled: boolean) => {
      window.postMessage({ source: 'page-pup', type: 'page-pup:error-monitoring', enabled }, window.location.origin);
    };
    const onErrorBridgeMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.source !== 'page-pup:error-bridge') return;
      if (event.data?.type === 'ready') setErrorMonitoring(true);
      if (event.data?.type === 'page-error') onPageError();
    };
    setErrorMonitoring(true);

    const interval = window.setInterval(() => {
      sampleVisible(Date.now());
      emitReadingIfDue();
      for (const candidate of Array.from(pending.values())) processCandidate(candidate);
    }, 2000);

    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('pointerdown', onOperation, true);
    document.addEventListener('keydown', onOperation, true);
    document.addEventListener('input', onInput, true);
    window.addEventListener('message', onErrorBridgeMessage);

    return () => {
      setErrorMonitoring(false);
      window.clearInterval(interval);
      window.clearTimeout(formTimer);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('pointerdown', onOperation, true);
      document.removeEventListener('keydown', onOperation, true);
      document.removeEventListener('input', onInput, true);
      window.removeEventListener('message', onErrorBridgeMessage);
    };
  }, [remindersEnabled, persistRecord, updateActiveReminder]);

  return { records, activeReminder, dismissReminder, muteActiveReminder };
}
