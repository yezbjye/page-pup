import { describe, expect, it } from 'vitest';
import { fitSquare, isSafeCustomImage } from '../shared/customImage';
import { CUSTOM_NAME_MAX_LENGTH, DEFAULT_SETTINGS, pupDisplayName } from '../shared/types';

describe('自定义名称', () => {
  it('默认与空白都回退为伴读小宠物', () => {
    expect(pupDisplayName(DEFAULT_SETTINGS)).toBe('伴读小宠物');
    expect(pupDisplayName({ customName: '   ' })).toBe('伴读小宠物');
  });

  it('使用自定义名称并截断过长输入', () => {
    expect(pupDisplayName({ customName: '  读书笔记猫  ' })).toBe('读书笔记猫');
    expect(pupDisplayName({ customName: '字'.repeat(30) })).toHaveLength(CUSTOM_NAME_MAX_LENGTH);
  });
});

describe('自定义形象图片', () => {
  it('等比缩小到 256px 内且不放大小图', () => {
    expect(fitSquare(1024, 512)).toEqual({ width: 256, height: 128 });
    expect(fitSquare(100, 200)).toEqual({ width: 100, height: 200 });
    expect(fitSquare(0, 0)).toEqual({ width: 1, height: 1 });
  });

  it('只接受体积受限的本地图片 data URL', () => {
    expect(isSafeCustomImage(`data:image/png;base64,${'A'.repeat(100)}`)).toBe(true);
    expect(isSafeCustomImage('https://example.com/a.png')).toBe(false);
    expect(isSafeCustomImage('data:text/html;base64,AAAA')).toBe(false);
    expect(isSafeCustomImage('data:image/png;base64,AAAA"><script>')).toBe(false);
    expect(isSafeCustomImage(`data:image/png;base64,${'A'.repeat(600_001)}`)).toBe(false);
  });
});
