import { describe, expect, test } from 'bun:test';
import { fold } from './fold';

describe('fold', () => {
  test('drops case and the Turkish marks, and makes ı an i', () => {
    expect(fold('ĞğIıİiŞşÇçÖöÜü')).toBe('ggiiiissccoouu');
    expect(fold('Doğancan')).toBe('dogancan');
  });
});
