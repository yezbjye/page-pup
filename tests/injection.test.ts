import { describe, expect, it } from 'vitest';
import { shouldInjectOn } from '../shared/storage';
import { DEFAULT_SETTINGS, type PupSettings } from '../shared/types';

const settings: PupSettings = {
  ...DEFAULT_SETTINGS,
  enabledSites: ['https://example.com/*'],
  enabledEverywhere: false,
  pausedSites: [],
};

const site = 'https://example.com/*';
const other = 'https://other.com/*';

describe('自动注入范围', () => {
  it('未启用时不注入任何网站', () => {
    const disabled = { ...settings, enabledSites: [] };
    expect(shouldInjectOn(disabled, site)).toBe(false);
    expect(shouldInjectOn(disabled, other)).toBe(false);
  });

  it('单独启用的网站才注入', () => {
    expect(shouldInjectOn(settings, site)).toBe(true);
    expect(shouldInjectOn(settings, other)).toBe(false);
  });

  it('全部启用时默认注入所有网站', () => {
    const everywhere = { ...settings, enabledEverywhere: true };
    expect(shouldInjectOn(everywhere, site)).toBe(true);
    expect(shouldInjectOn(everywhere, other)).toBe(true);
  });

  it('全部启用时仍尊重单站暂停', () => {
    const everywhere = { ...settings, enabledEverywhere: true, pausedSites: [other] };
    expect(shouldInjectOn(everywhere, other)).toBe(false);
    expect(shouldInjectOn(everywhere, site)).toBe(true);
  });
});
