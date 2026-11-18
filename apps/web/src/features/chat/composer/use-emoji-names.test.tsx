/** The names are a chunk fetched on the first colon; a fetch that fails offers nothing and breaks nothing. */
import { afterAll, expect, mock, test } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { installDom } from '../../../testing/dom';
import { useEmojiNames } from './use-emoji-names';

installDom();
const listPath = require.resolve('./emoji-list');
afterAll(() => {
  Reflect.deleteProperty(require.cache, listPath);
});

test('a chunk that cannot be fetched leaves the names unloaded and throws nothing', async () => {
  Reflect.deleteProperty(require.cache, listPath);
  await mock.module('./emoji-list', () => {
    throw new TypeError('Failed to fetch dynamically imported module');
  });
  const { result } = renderHook(() => useEmojiNames(true));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(result.current).toBeNull();
});
