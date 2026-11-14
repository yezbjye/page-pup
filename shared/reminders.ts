import type { PupSettings, ReminderRecord, ReminderType } from './types';

export const REMINDER_TIMING = {
  readingActiveMs: 8 * 60 * 1000,
  readingCooldownMs: 30 * 60 * 1000,
  readingScrollReversals: 3,
  formIdleMs: 45 * 1000,
  formCooldownMs: 20 * 60 * 1000,
  errorWindowMs: 8 * 1000,
  errorCooldownMs: 10 * 60 * 1000,
  errorCandidateIntervalMs: 60 * 1000,
  breakCooldownMs: 5 * 60 * 1000,
  interactionDelayMs: 1800,
} as const;

export type ReminderCandidate = Pick<ReminderRecord, 'id' | 'type' | 'message' | 'reason' | 'createdAt'>;

interface ReminderFacts {
  activeMinutes?: number;
  scrollReversals?: number;
  idleSeconds?: number;
  errorWindowSeconds?: number;
  breakMinutes?: number;
}

export function createReminderCandidate(
  type: ReminderType,
  createdAt: number,
  facts: ReminderFacts = {},
): ReminderCandidate {
  if (type === 'reading') {
    return {
      id: crypto.randomUUID(),
      type,
      createdAt,
      message: '这一页已经读了一段时间，可以停下来回顾刚才的重点。',
      reason: `此页可见阅读已累计 ${facts.activeMinutes ?? 0} 分钟，并出现 ${facts.scrollReversals ?? 0} 次来回滚动；未读取页面正文。`,
    };
  }
  if (type === 'form') {
    return {
      id: crypto.randomUUID(),
      type,
      createdAt,
      message: '你似乎在填写时停了下来，可以稍后再继续，不必急着完成。',
      reason: `检测到表单输入后连续 ${facts.idleSeconds ?? 0} 秒没有继续输入；未读取或保存填写内容。`,
    };
  }
  if (type === 'break') {
    return {
      id: crypto.randomUUID(),
      type,
      createdAt,
      message: '已经专注了一阵子，起来活动一下，让眼睛也歇一歇。',
      reason: `可见阅读已连续累计 ${facts.breakMinutes ?? 0} 分钟，达到你设置的休息提醒间隔；未读取页面正文。`,
    };
  }
  return {
    id: crypto.randomUUID(),
    type,
    createdAt,
    message: '刚才的操作可能没有生效，可以查看页面提示或稍后再试。',
    reason: `检测到点击或按键后 ${facts.errorWindowSeconds ?? 0} 秒内出现页面错误事件；未读取错误内容或堆栈。`,
  };
}

export interface ReadingActivityState {
  lastSampleAt: number;
  wasVisible: boolean;
  visibleMs: number;
  lastScrollY: number;
  scrollDirection: -1 | 0 | 1;
  scrollReversals: number;
  emitted: boolean;
}

export function createReadingActivity(now: number, scrollY: number, visible: boolean): ReadingActivityState {
  return {
    lastSampleAt: now,
    wasVisible: visible,
    visibleMs: 0,
    lastScrollY: scrollY,
    scrollDirection: 0,
    scrollReversals: 0,
    emitted: false,
  };
}

export function sampleReadingActivity(state: ReadingActivityState, now: number, visible: boolean): void {
  if (state.wasVisible) state.visibleMs += Math.max(0, now - state.lastSampleAt);
  state.lastSampleAt = now;
  state.wasVisible = visible;
}

export function recordReadingScroll(state: ReadingActivityState, scrollY: number): void {
  const delta = scrollY - state.lastScrollY;
  if (Math.abs(delta) < 32) return;
  const direction = delta > 0 ? 1 : -1;
  if (state.scrollDirection !== 0 && direction !== state.scrollDirection) state.scrollReversals += 1;
  state.scrollDirection = direction;
  state.lastScrollY = scrollY;
}

export function readingReminderDue(
  state: ReadingActivityState,
  activeMs: number = REMINDER_TIMING.readingActiveMs,
): boolean {
  return !state.emitted &&
    state.visibleMs >= activeMs &&
    state.scrollReversals >= REMINDER_TIMING.readingScrollReversals;
}

export interface ReminderDecision {
  record: ReminderRecord | null;
  show: boolean;
  deferred: boolean;
  applyCooldown: boolean;
}

export function decideReminder(
  candidate: ReminderCandidate,
  context: {
    settings: PupSettings;
    now: number;
    busy: boolean;
    alreadyDeferred: boolean;
    lastDecisionAt?: number;
  },
): ReminderDecision {
  const empty = { record: null, show: false, deferred: false, applyCooldown: false };
  if (!context.settings.remindersEnabled) return empty;

  const record = (status: ReminderRecord['status'], suppressionReason?: string): ReminderRecord => ({
    ...candidate,
    createdAt: context.now,
    status,
    suppressionReason,
  });

  if (context.busy) {
    return {
      record: context.alreadyDeferred ? null : record('deferred', '你正在操作或查看上一条提醒，等安静后再判断。'),
      show: false,
      deferred: true,
      applyCooldown: false,
    };
  }

  if (context.settings.mutedReminders.includes(candidate.type)) {
    return {
      record: record('muted', '此类提醒已永久静音，可在设置中恢复。'),
      show: false,
      deferred: false,
      applyCooldown: true,
    };
  }

  const cooldown = candidate.type === 'reading'
    ? REMINDER_TIMING.readingCooldownMs
    : candidate.type === 'form'
      ? REMINDER_TIMING.formCooldownMs
      : candidate.type === 'break'
        ? REMINDER_TIMING.breakCooldownMs
        : REMINDER_TIMING.errorCooldownMs;
  if (context.lastDecisionAt !== undefined && context.now - context.lastDecisionAt < cooldown) {
    return {
      record: record('cooldown', `距离上次同类提醒不足 ${Math.round(cooldown / 60000)} 分钟，本次不主动展示。`),
      show: false,
      deferred: false,
      applyCooldown: false,
    };
  }

  return { record: record('shown'), show: true, deferred: false, applyCooldown: true };
}
