/**
 * The measurement itself (#73): a real API, started against the database, read once it has settled.
 * What it answers must be a real process's memory, and today's must be inside the budget.
 */
import { describe, expect, test } from 'bun:test';
import { BUDGET_BYTES, freePort, measureIdleRss, rssOf } from './budget-api';

const url = process.env['DATABASE_URL'] ?? '';

describe('integration: the API idle memory measurement', () => {
  test('reads a real resident set, of this process and of a started API', async () => {
    expect(rssOf(process.pid)).toBeGreaterThan(1024 * 1024);
    expect(await freePort()).toBeGreaterThan(0);
    const rss = await measureIdleRss(url);
    // A started Bun process is never this small; a measurement that read nothing would be.
    expect(rss).toBeGreaterThan(20 * 1024 * 1024);
    expect(rss).toBeLessThan(BUDGET_BYTES);
  }, 90_000);

  test('an API that cannot start is not a budget passed: it throws', async () => {
    expect(
      await measureIdleRss('postgres://nobody:nothing@localhost:1/none').then(
        () => 'measured',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    ).toContain('did not become ready');
  }, 90_000);
});
