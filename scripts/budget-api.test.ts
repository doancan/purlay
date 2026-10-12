/**
 * The API's idle memory budget (`PRD.md` §5, D-49, #73): a process that has started, migrated and
 * answered readiness, left alone a moment, must hold under 120 MiB. What is judged here is the
 * verdict and the words; the measurement is `budget-api.ts` itself, run by CI against a database.
 */
import { describe, expect, test } from 'bun:test';
import { BUDGET_BYTES, judge, main } from './budget-api';

const MIB = 1024 * 1024;

describe('the idle RSS verdict', () => {
  test('under the budget passes, and says how much room is left', () => {
    expect(judge(96 * MIB)).toEqual({
      ok: true,
      line: 'API idle RSS: 96.0 MiB of 120 MiB (24.0 MiB to spare)',
    });
  });

  test('at the budget, or over it, fails, and says by how much', () => {
    expect(judge(BUDGET_BYTES).ok).toBe(false);
    expect(judge(BUDGET_BYTES - 1).ok).toBe(true);
    expect(judge(130 * MIB)).toEqual({
      ok: false,
      line: 'API idle RSS: 130.0 MiB of 120 MiB — 10.0 MiB over (PRD.md §5)',
    });
  });
});

describe('the command', () => {
  const MIB_ = 1024 * 1024;
  test('with no database it says it measured nothing — and in CI refuses, rather than pass unmeasured', async () => {
    expect(await main({})).toEqual({
      line: "budget:api — DATABASE_URL is not set: the API's idle memory was NOT measured.",
      code: 0,
    });
    expect((await main({ CI: 'true' })).code).toBe(1);
    const unreachable = await main({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' });
    expect(unreachable.line).toContain('nothing answers at 127.0.0.1:1');
  });

  test('with one, it is the verdict on what was measured', async () => {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data: () => undefined },
    });
    const url = `postgres://u:p@127.0.0.1:${String(listener.port)}/db`;
    expect(await main({ DATABASE_URL: url }, () => Promise.resolve(90 * MIB_))).toMatchObject({
      code: 0,
    });
    expect(await main({ DATABASE_URL: url }, () => Promise.resolve(121 * MIB_))).toMatchObject({
      code: 1,
    });
    listener.stop(true);
  });
});
