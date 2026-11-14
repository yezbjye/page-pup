export const NUDGE_TIPS = [
  '选中一段文字，我可以解释、压要点或翻译。',
  '想快速了解这一页？点「总结整页」试试。',
  '结果可以复制，也可以导出成 Markdown 粘到笔记里。',
  '拖动我会记住位置，下次打开还在原处。',
  '读累了可以点我收起，不会挡住正文。',
] as const;

export const NUDGE_GAP_MS = 4 * 60 * 1000;

export function pickNudge(random: () => number = Math.random): string {
  const index = Math.min(NUDGE_TIPS.length - 1, Math.floor(random() * NUDGE_TIPS.length));
  return NUDGE_TIPS[index]!;
}

export function nudgeDelayMs(random: () => number = Math.random): number {
  return 45000 + Math.floor(random() * 45000);
}
