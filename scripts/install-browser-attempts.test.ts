import { describe, expect, test } from 'bun:test';
import {
  APT_TIMEOUTS,
  APT_TIMEOUTS_FILE,
  browserOf,
  installCommand,
  installWithRetries,
  TRIES,
  TRY_LIMIT_MS,
  type Outcome,
} from './install-browser-attempts';

const runs = (
  outcomes: Outcome[],
): { run: (limitMs: number) => Promise<Outcome>; limits: number[] } => {
  const limits: number[] = [];
  return {
    limits,
    run: (limitMs): Promise<Outcome> => {
      limits.push(limitMs);
      return Promise.resolve(outcomes[limits.length - 1] ?? 'failed');
    },
  };
};

describe('installing a browser, with a stall cut and tried again', () => {
  test('a try that finishes is the end of it: no second try, exit code 0', async () => {
    const { run, limits } = runs(['done']);
    const said: string[] = [];
    expect(await installWithRetries('webkit', run, (line) => said.push(line))).toBe(0);
    expect(limits).toEqual([TRY_LIMIT_MS]);
    expect(said).toEqual([]);
  });

  test('a stall is tried again, and the try that follows can finish', async () => {
    const { run, limits } = runs(['stalled', 'done']);
    const said: string[] = [];
    expect(await installWithRetries('webkit', run, (line) => said.push(line))).toBe(0);
    expect(limits).toHaveLength(2);
    expect(said).toEqual(['installing webkit, try 1 of 3: stalled']);
  });

  test('three tries that fail or stall are a failure, said once for each', async () => {
    const { run, limits } = runs(['failed', 'stalled', 'failed']);
    const said: string[] = [];
    expect(await installWithRetries('chromium', run, (line) => said.push(line))).toBe(1);
    expect(limits).toHaveLength(TRIES);
    expect(said).toEqual([
      'installing chromium, try 1 of 3: failed',
      'installing chromium, try 2 of 3: stalled',
      'installing chromium, try 3 of 3: failed',
    ]);
  });

  test('the tries and the time are set by the caller', async () => {
    const { run, limits } = runs(['failed', 'failed']);
    expect(await installWithRetries('webkit', run, () => undefined, 2, 5)).toBe(1);
    expect(limits).toEqual([5, 5]);
  });

  test('a try installs with the playwright the lockfile pins, from the web workspace', () => {
    expect(installCommand('webkit')).toEqual([
      'bun',
      '--no-env-file',
      'run',
      '--cwd',
      'apps/web',
      'playwright',
      'install',
      '--with-deps',
      'webkit',
    ]);
  });

  test('only the two browsers the suite uses are installed', () => {
    expect(browserOf('chromium')).toBe('chromium');
    expect(browserOf('webkit')).toBe('webkit');
    expect(browserOf('firefox')).toBeUndefined();
    expect(browserOf(undefined)).toBeUndefined();
  });

  test('apt is told to give up on a stalled mirror and to wait for the lock an earlier try left', () => {
    expect(APT_TIMEOUTS).toContain('Acquire::http::Timeout "20";');
    expect(APT_TIMEOUTS).toContain('Acquire::Retries "3";');
    expect(APT_TIMEOUTS).toContain('DPkg::Lock::Timeout "120";');
    expect(APT_TIMEOUTS.endsWith('\n')).toBe(true);
    expect(APT_TIMEOUTS_FILE).toMatch(/^\/etc\/apt\/apt\.conf\.d\/[0-9]+[a-z-]+$/);
  });
});
