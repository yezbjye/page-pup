import {
  DEFAULT_SETTINGS,
  DEFAULT_UI_STATE,
  type PupSettings,
  type PupUiState,
  type ReminderRecord,
} from './types';

export const SETTINGS_KEY = 'pagePup.settings';
const UI_KEY = 'pagePup.ui';
const POSITIONS_KEY = 'pagePup.positions';
const REMINDERS_KEY = 'pagePup.reminders';
const MAX_REMINDERS = 100;
const MAX_SITE_POSITIONS = 50;

export interface SitePosition {
  xRatio: number;
  yRatio: number;
}

function storageArea() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('chrome.storage.local 不可用');
  }
  return chrome.storage.local;
}

export async function getSettings(): Promise<PupSettings> {
  const result = await storageArea().get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] ?? {}) };
}

export async function saveSettings(settings: PupSettings): Promise<void> {
  await storageArea().set({ [SETTINGS_KEY]: settings });
}

export async function getUiState(): Promise<PupUiState> {
  const result = await storageArea().get(UI_KEY);
  return { ...DEFAULT_UI_STATE, ...(result[UI_KEY] ?? {}) };
}

export async function saveUiState(state: PupUiState): Promise<void> {
  await storageArea().set({ [UI_KEY]: state });
}

export async function getSitePosition(site: string): Promise<SitePosition | null> {
  const result = await storageArea().get(POSITIONS_KEY);
  const map = (result[POSITIONS_KEY] ?? {}) as Record<string, Partial<SitePosition>>;
  const value = map[site];
  if (!value || !Number.isFinite(value.xRatio) || !Number.isFinite(value.yRatio)) return null;
  return { xRatio: value.xRatio as number, yRatio: value.yRatio as number };
}

export async function saveSitePosition(site: string, position: SitePosition): Promise<void> {
  const result = await storageArea().get(POSITIONS_KEY);
  const map = (result[POSITIONS_KEY] ?? {}) as Record<string, SitePosition & { updatedAt?: number }>;
  map[site] = { ...position, updatedAt: Date.now() };
  const kept = Object.entries(map)
    .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
    .slice(0, MAX_SITE_POSITIONS);
  await storageArea().set({ [POSITIONS_KEY]: Object.fromEntries(kept) });
}

export async function getReminderRecords(): Promise<ReminderRecord[]> {
  const result = await storageArea().get(REMINDERS_KEY);
  return Array.isArray(result[REMINDERS_KEY]) ? result[REMINDERS_KEY] : [];
}

export async function saveReminderRecord(record: ReminderRecord): Promise<ReminderRecord[]> {
  const current = await getReminderRecords();
  const next = [record, ...current.filter((item) => item.id !== record.id)].slice(0, MAX_REMINDERS);
  await storageArea().set({ [REMINDERS_KEY]: next });
  return next;
}

export async function clearReminderRecords(): Promise<void> {
  await storageArea().set({ [REMINDERS_KEY]: [] });
}

export function originPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

export const ALL_SITE_ORIGINS = ['https://*/*', 'http://*/*'];

export function shouldInjectOn(settings: PupSettings, pattern: string): boolean {
  if (settings.pausedSites.includes(pattern)) return false;
  return settings.enabledEverywhere || settings.enabledSites.includes(pattern);
}
