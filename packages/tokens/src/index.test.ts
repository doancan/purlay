import { expect, test } from 'bun:test';
import { cssVar, defaultTheme, themes } from './index';

test('cssVar spells the custom property the generated CSS defines', () => {
  expect(cssVar('surface-100')).toBe('var(--surface-100)');
  expect(cssVar('space-4')).toBe('var(--space-4)');
});

test('the default theme is one of the themes, and the first', () => {
  expect(themes[0]).toBe(defaultTheme);
});
