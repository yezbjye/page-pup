import { describe, expect, it } from 'vitest';
import { NUDGE_TIPS, nudgeDelayMs, pickNudge } from '../shared/nudges';

describe('空闲随机互动', () => {
  it('只在预设的轻量提示里随机选择', () => {
    expect(pickNudge(() => 0)).toBe(NUDGE_TIPS[0]);
    expect(pickNudge(() => 0.999)).toBe(NUDGE_TIPS[NUDGE_TIPS.length - 1]);
    expect(pickNudge(() => 1)).toBe(NUDGE_TIPS[NUDGE_TIPS.length - 1]);
  });

  it('空闲等待时间落在 45 到 90 秒之间', () => {
    expect(nudgeDelayMs(() => 0)).toBe(45000);
    expect(nudgeDelayMs(() => 0.5)).toBe(67500);
    expect(nudgeDelayMs(() => 0.999)).toBeLessThan(90000);
  });
});
