/**
 * The measurement itself (#73): a real API, started against a clone of the test template, read once it
 * has settled.
 * What it answers must be a real process's memory, and today's must be inside the budget.
 */
import { describe, expect, test } from 'bun:test';
import { BUDGET_BYTES, freePort, measureIdleRss, onAClone, rssOf } from './budget-api';

describe('integration: the API idle memory measurement', () => {
  test('reads a real resident set, of this process and of a started API', async () => {
    expect(rssOf(process.pid)).toBeGreaterThan(1024 * 1024);
    expect(await freePort()).toBeGreaterThan(0);
    // On a clone of its own: the API migrates and writes its settings where it is started.
    const rss = await onAClone(measureIdleRss);
    // A started Bun process is never this small; a measurement that read nothing would be.
    expect(rss).toBeGreaterThan(20 * 1024 * 1024);
    expect(rss).toBeLessThan(BUDGET_BYTES);
  }, 90_000);

  test('an API that cannot start is not a budget passed: it throws', async () => {
    expect(
      await measureIdleRss('postgres://nobody:nothing@localhost:1/none_0123456789ab').then(
        () => 'measured',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    ).toContain('did not become ready');
  }, 90_000);
});
