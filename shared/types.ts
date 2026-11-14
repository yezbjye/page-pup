export type ReadingOperation = 'explain' | 'summarize' | 'translate';

export type ReadingLength = 'one' | 'three' | 'bullets';

export const READING_LENGTH_LABELS: Record<ReadingLength, string> = {
  one: '一句话',
  three: '三句话',
  bullets: '要点',
};

export const READING_LENGTH_LIMITS: Record<ReadingLength, number> = {
  one: 1,
  three: 3,
  bullets: 6,
};

export interface SourceSegment {
  id: string;
  text: string;
}

export interface ReadingItem {
  text: string;
  evidenceIds: string[];
}

export interface ReadingResult {
  status: 'ok' | 'insufficient';
  items: ReadingItem[];
  sources: SourceSegment[];
  operation: ReadingOperation;
}

export type ReminderType = 'reading' | 'form' | 'error' | 'break';

export const BREAK_MINUTES_OPTIONS = [30, 45, 60] as const;
export type BreakMinutes = (typeof BREAK_MINUTES_OPTIONS)[number];

export type PetId = 'shiba' | 'cat' | 'hamster' | 'penguin' | 'rabbit' | 'red-panda' | 'custom';

export interface PetOption {
  id: PetId;
  label: string;
  file: string;
}

export const PET_OPTIONS: PetOption[] = [
  { id: 'shiba', label: '柴犬', file: 'pets/shiba.jpg' },
  { id: 'cat', label: '小猫', file: 'pets/cat.jpg' },
  { id: 'hamster', label: '仓鼠', file: 'pets/hamster.jpg' },
  { id: 'penguin', label: '企鹅', file: 'pets/penguin.jpg' },
  { id: 'rabbit', label: '兔子', file: 'pets/rabbit.jpg' },
  { id: 'red-panda', label: '小熊猫', file: 'pets/red-panda.jpg' },
];

export function petOption(id: PetId): PetOption {
  return PET_OPTIONS.find((option) => option.id === id) ?? PET_OPTIONS[0]!;
}

export const DEFAULT_PUP_NAME = '伴读小狗';
export const CUSTOM_NAME_MAX_LENGTH = 12;

export function pupDisplayName(settings: Pick<PupSettings, 'customName'>): string {
  return settings.customName.trim().slice(0, CUSTOM_NAME_MAX_LENGTH) || DEFAULT_PUP_NAME;
}

export type ReminderStatus =
  | 'shown'
  | 'dismissed'
  | 'muted'
  | 'cooldown'
  | 'deferred'
  | 'expired';

export interface ReminderRecord {
  id: string;
  type: ReminderType;
  message: string;
  reason: string;
  createdAt: number;
  status: ReminderStatus;
  suppressionReason?: string;
}

export interface PupSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  enabledSites: string[];
  enabledEverywhere: boolean;
  pausedSites: string[];
  remindersEnabled: boolean;
  mutedReminders: ReminderType[];
  pet: PetId;
  readingThresholdMinutes: 1 | 3 | 8;
  breakReminderEnabled: boolean;
  breakReminderMinutes: BreakMinutes;
  idleNudgesEnabled: boolean;
  customName: string;
  customImage: string;
}

export interface PupUiState {
  xRatio: number;
  yRatio: number;
  collapsed: boolean;
}

export const DEFAULT_SETTINGS: PupSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  enabledSites: [],
  enabledEverywhere: false,
  pausedSites: [],
  remindersEnabled: true,
  mutedReminders: [],
  pet: 'shiba',
  readingThresholdMinutes: 8,
  breakReminderEnabled: false,
  breakReminderMinutes: 45,
  idleNudgesEnabled: true,
  customName: '',
  customImage: '',
};

export const DEFAULT_UI_STATE: PupUiState = {
  xRatio: 1,
  yRatio: 1,
  collapsed: false,
};

export const REMINDER_LABELS: Record<ReminderType, string> = {
  reading: '长时间阅读',
  form: '表单停顿',
  error: '页面错误',
  break: '休息提醒',
};
