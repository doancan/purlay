/**
 * The columns readiness checks are the columns the migrations collate — bound,
 * because a running process cannot read its migrations' text (#108).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLATED_COLUMNS, READINESS_FRESH_MS, recentReadiness, type Readiness } from './readiness';

const MIGRATIONS = 'packages/db/migrations';

/** `(table, column)` for every column a migration declares `COLLATE "C"`. */
const collatedInMigrations = (): string[] => {
  const found: string[] = [];
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const table of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
      for (const column of (table[2] ?? '').matchAll(/^\s*(\w+)\s+[^\n]*COLLATE "C"/gm)) {
        found.push(`${table[1] ?? ''}.${column[1] ?? ''}`);
      }
    }
  }
  return found.sort();
};

describe('the columns readiness checks', () => {
  test('are exactly the ones the migrations declare COLLATE "C"', () => {
    const declared = collatedInMigrations();
    expect(declared.length).toBeGreaterThan(0);
    expect(COLLATED_COLUMNS.map(([table, column]) => `${table}.${column}`).sort()).toEqual(
      declared,
    );
  });
});

describe('readiness asked from outside (#636)', () => {
  const counting = (): {
    check: () => Promise<Readiness>;
    calls: () => number;
    settle: (answer: Readiness) => void;
  } => {
    let calls = 0;
    let settle: (answer: Readiness) => void = () => undefined;
    return {
      check: () => {
        calls += 1;
        return new Promise<Readiness>((resolve) => {
          settle = resolve;
        });
      },
      calls: () => calls,
      settle: (answer) => {
        settle(answer);
      },
    };
  };
  const clockAt = (): { now: () => Date; advance: (ms: number) => void } => {
    let at = Date.parse('2026-10-15T12:00:00.000Z');
    return {
      now: () => new Date(at),
      advance: (ms) => {
        at += ms;
      },
    };
  };

  test('however many ask at once, the database is asked once', async () => {
    const probe = counting();
    const ask = recentReadiness(probe.check, clockAt());
    const answers = Promise.all([ask(), ask(), ask()]);
    probe.settle({ ready: true });
    expect(await answers).toEqual([{ ready: true }, { ready: true }, { ready: true }]);
    expect(probe.calls()).toBe(1);
  });

  test('an answer younger than a second is the answer; an older one is asked again', async () => {
    const probe = counting();
    const clock = clockAt();
    const ask = recentReadiness(probe.check, clock);
    const first = ask();
    probe.settle({ ready: true });
    await first;
    clock.advance(READINESS_FRESH_MS - 1);
    expect(await ask()).toEqual({ ready: true });
    expect(probe.calls()).toBe(1);
    clock.advance(1);
    const again = ask();
    probe.settle({ ready: false, reason: 'the database did not answer: gone' });
    expect(await again).toEqual({ ready: false, reason: 'the database did not answer: gone' });
    expect(probe.calls()).toBe(2);
  });
});
