import { afterEach, describe, expect, test } from 'bun:test';
import { compareText, setCollationLocale } from './collation';

afterEach(() => {
  setCollationLocale('en');
});

describe('ordering text by the language showing', () => {
  test('Turkish puts ç after c and ı before i; English files them with their base letters', () => {
    const words = ['ilk', 'çay', 'cam', 'ışık'];
    setCollationLocale('tr');
    expect([...words].sort(compareText)).toEqual(['cam', 'çay', 'ışık', 'ilk']);
    setCollationLocale('en');
    expect([...words].sort(compareText)).not.toEqual(['cam', 'çay', 'ışık', 'ilk']);
  });
});
