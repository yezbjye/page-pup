import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PET_OPTIONS, petOption } from '../shared/types';

describe('陪伴形象', () => {
  it('提供六种可选形象', () => {
    expect(PET_OPTIONS).toHaveLength(6);
    expect(new Set(PET_OPTIONS.map((option) => option.id)).size).toBe(6);
    expect(new Set(PET_OPTIONS.map((option) => option.file)).size).toBe(6);
  });

  it('默认使用柴犬', () => {
    expect(DEFAULT_SETTINGS.pet).toBe('shiba');
    expect(petOption('shiba').label).toBe('柴犬');
  });

  it('每张形象资源都在构建目录中', () => {
    const expected = ['shiba', 'cat', 'hamster', 'penguin', 'rabbit', 'red-panda'];
    expect(PET_OPTIONS.map((option) => option.id)).toEqual(expected);
    expect(PET_OPTIONS.every((option) => option.file.startsWith('pets/'))).toBe(true);
  });
});
