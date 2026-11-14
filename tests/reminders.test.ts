import { describe, expect, it } from 'vitest';
import {
  createReadingActivity,
  createReminderCandidate,
  decideReminder,
  readingReminderDue,
  recordReadingScroll,
  REMINDER_TIMING,
  sampleReadingActivity,
  type ReminderCandidate,
} from '../shared/reminders';
import { DEFAULT_SETTINGS } from '../shared/types';

const candidate: ReminderCandidate = {
  id: 'reminder-1',
  type: 'form',
  message: '可以稍后再继续。',
  reason: '输入后停顿 45 秒。',
  createdAt: 1000,
};
const settings = { ...DEFAULT_SETTINGS, remindersEnabled: true, mutedReminders: [] };

describe('克制提醒规则', () => {
  it('阅读时长和来回滚动都达到依据后才提醒，并且每轮只发一次', () => {
    const state = createReadingActivity(0, 0, true);
    sampleReadingActivity(state, REMINDER_TIMING.readingActiveMs, true);
    expect(readingReminderDue(state)).toBe(false);

    for (const scrollY of [100, 0, 100, 0]) recordReadingScroll(state, scrollY);
    expect(state.scrollReversals).toBe(3);
    expect(readingReminderDue(state)).toBe(true);
    state.emitted = true;
    expect(readingReminderDue(state)).toBe(false);
  });

  it('允许把阅读门槛调到 1 分钟，且仍要求来回滚动依据', () => {
    const state = createReadingActivity(0, 0, true);
    sampleReadingActivity(state, 60000, true);
    for (const scrollY of [100, 0, 100, 0]) recordReadingScroll(state, scrollY);
    expect(readingReminderDue(state, 60000)).toBe(true);

    const early = createReadingActivity(0, 0, true);
    sampleReadingActivity(early, 59000, true);
    for (const scrollY of [100, 0, 100, 0]) recordReadingScroll(early, scrollY);
    expect(readingReminderDue(early, 60000)).toBe(false);
  });

  it('页面隐藏期间不计入可见阅读时长', () => {
    const state = createReadingActivity(0, 0, true);
    sampleReadingActivity(state, 1000, false);
    sampleReadingActivity(state, 9000, true);
    sampleReadingActivity(state, 10000, true);
    expect(state.visibleMs).toBe(2000);
  });

  it('忽略微小滚动，只记录有效方向反转', () => {
    const state = createReadingActivity(0, 0, true);
    for (const scrollY of [10, 100, 110, 0, 5, 100]) recordReadingScroll(state, scrollY);
    expect(state.scrollReversals).toBe(2);
  });

  it('展示提醒时保留具体依据', () => {
    const decision = decideReminder(candidate, { settings, now: 2000, busy: false, alreadyDeferred: false });
    expect(decision.show).toBe(true);
    expect(decision.record).toMatchObject({ id: 'reminder-1', status: 'shown', reason: '输入后停顿 45 秒。' });
  });

  it('永久静音只记录不展示', () => {
    const decision = decideReminder(candidate, {
      settings: { ...settings, mutedReminders: ['form'] },
      now: 2000,
      busy: false,
      alreadyDeferred: false,
    });
    expect(decision.show).toBe(false);
    expect(decision.record).toMatchObject({ status: 'muted', suppressionReason: '此类提醒已永久静音，可在设置中恢复。' });
  });

  it('冷却中的同类提醒只记录不展示', () => {
    const decision = decideReminder(candidate, {
      settings,
      now: 2000,
      lastDecisionAt: 1000,
      busy: false,
      alreadyDeferred: false,
    });
    expect(decision.show).toBe(false);
    expect(decision.record?.status).toBe('cooldown');
  });

  it('操作时只记录一次延迟，安静后用同一记录展示', () => {
    const first = decideReminder(candidate, { settings, now: 2000, busy: true, alreadyDeferred: false });
    const waiting = decideReminder(candidate, { settings, now: 3000, busy: true, alreadyDeferred: true });
    const shown = decideReminder(candidate, { settings, now: 4000, busy: false, alreadyDeferred: true });
    expect(first.record?.status).toBe('deferred');
    expect(waiting.record).toBeNull();
    expect(shown.record).toMatchObject({ id: candidate.id, status: 'shown', createdAt: 4000 });
  });

  it('总开关关闭时不生成记录也不展示', () => {
    const decision = decideReminder(candidate, {
      settings: { ...settings, remindersEnabled: false },
      now: 2000,
      busy: false,
      alreadyDeferred: false,
    });
    expect(decision.record).toBeNull();
    expect(decision.show).toBe(false);
  });

  it('休息提醒说明连续阅读分钟数，并支持静音', () => {
    const breakCandidate = createReminderCandidate('break', 1000, { breakMinutes: 45 });
    expect(breakCandidate.type).toBe('break');
    expect(breakCandidate.reason).toContain('45 分钟');
    expect(breakCandidate.message).toContain('活动');

    const muted = decideReminder(breakCandidate, {
      settings: { ...settings, mutedReminders: ['break'] },
      now: 2000,
      busy: false,
      alreadyDeferred: false,
    });
    expect(muted.show).toBe(false);
    expect(muted.record?.status).toBe('muted');
  });

  it('提醒依据只包含事件元数据', () => {
    const form = createReminderCandidate('form', 1000, { idleSeconds: 45 });
    const error = createReminderCandidate('error', 1000, { errorWindowSeconds: 8 });
    expect(form.reason).toContain('未读取或保存填写内容');
    expect(error.reason).toContain('未读取错误内容或堆栈');
  });
});
