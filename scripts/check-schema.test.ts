import { describe, expect, test } from 'bun:test';

/**
 * `bun run db:check` migrates the database it is given: the one a developer works in must be refused
 * before anything is touched. The guard runs first, so these need no database.
 */
const check = (environment: Record<string, string>): { code: number; error: string } => {
  const result = Bun.spawnSync(['./scripts/check-schema.sh'], {
    env: { PATH: process.env['PATH'] ?? '', ...environment },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return { code: result.exitCode, error: result.stderr.toString() };
};

describe('db:check refuses a database that is not a throwaway one', () => {
  const dev = 'postgres://purlay:purlay@localhost:1/purlay';

  test('the development database', () => {
    const result = check({ DATABASE_URL: dev });
    expect(result.code).toBe(2);
    expect(result.error).toContain('"purlay" is not a throwaway one');
  });

  test('a query string does not hide the name', () => {
    expect(check({ DATABASE_URL: `${dev}?sslmode=disable` }).code).toBe(2);
  });

  test('an allowance for another database is not an allowance for this one', () => {
    expect(check({ DATABASE_URL: dev, PURLAY_ALLOW_DB_CHECK_ON: 'purlay_spike' }).code).toBe(2);
  });

  test('a name that only looks like a clone is refused', () => {
    expect(check({ DATABASE_URL: 'postgres://u:p@localhost:1/purlay_abc123' }).code).toBe(2);
  });

  test('a named allowance, or a clone name, passes the guard (and fails later, on the dead port)', () => {
    expect(check({ DATABASE_URL: dev, PURLAY_ALLOW_DB_CHECK_ON: 'purlay' }).code).not.toBe(2);
    expect(check({ DATABASE_URL: 'postgres://u:p@localhost:1/purlay_0123456789ab' }).code).not.toBe(
      2,
    );
  });
});
