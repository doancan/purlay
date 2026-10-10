import { expect, test } from 'bun:test';
import { promptOf } from './composer';

test('a name that fits sits before the prompt; one that does not is never cut, and a reply box has none', () => {
  expect(promptOf('api', false)).toBe('api ›');
  expect(promptOf('ops-x', false)).toBe('ops-x ›');
  expect(promptOf('deploys', false)).toBe('›');
  expect(promptOf('Message a thread in api', true)).toBe('›');
  expect(promptOf('api', true)).toBe('›');
});
