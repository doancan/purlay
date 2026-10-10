import { expect, test } from 'bun:test';
import { systemClock } from './system-clock';

test("the system clock is the browser's, and the only one", () => {
  const before = Date.now();
  const read = systemClock.now().getTime();
  expect(read).toBeGreaterThanOrEqual(before);
  expect(read).toBeLessThanOrEqual(Date.now());
});
