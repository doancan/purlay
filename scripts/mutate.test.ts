/**
 * The mutation runner, run on a repository of its own: a function with a test that
 * checks one of its two guards. A runner that reports "caught" for everything is
 * the failure to rule out, so the fixture has a mutation that must survive and one
 * that must be caught, and the runner must tell them apart (`CONTRIBUTING.md` §6.4).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptable, mutate, report, runMutations, type Mutation } from './mutate';

const roots: string[] = [];

/** `clamp` has two guards; its test exercises the upper one only. */
const aRepository = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'purlay-mutate-fixture-'));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'src', 'clamp.ts'),
    'export const clamp = (n: number): number => {\n  if (n > 10) return 10;\n  if (n < 0) return 0;\n  return n;\n};\n',
  );
  writeFileSync(
    join(root, 'src', 'clamp.test.ts'),
    "import { expect, test } from 'bun:test';\nimport { clamp } from './clamp';\ntest('clamps high', () => {\n  expect(clamp(99)).toBe(10);\n  expect(clamp(5)).toBe(5);\n});\n",
  );
  return root;
};

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const killed: Mutation = {
  id: 'upper-guard-removed',
  why: 'a value above the maximum passes through',
  file: 'src/clamp.ts',
  find: 'if (n > 10) return 10;',
  replace: '',
  tests: ['src/clamp.test.ts'],
};
const survivor: Mutation = {
  id: 'lower-guard-removed',
  why: 'a negative value passes through — and nothing tests it',
  file: 'src/clamp.ts',
  find: 'if (n < 0) return 0;',
  replace: '',
  tests: ['src/clamp.test.ts'],
};

describe('the mutation runner', () => {
  test('reports a mutation the tests notice as caught, and one they do not as survived', () => {
    const root = aRepository();
    const verdicts = runMutations({ root, mutations: [killed, survivor] });
    expect(verdicts.map((v) => [v.id, v.outcome])).toEqual([
      ['upper-guard-removed', 'caught'],
      ['lower-guard-removed', 'survived'],
    ]);
    expect(acceptable(verdicts)).toBe(false);
    expect(report(verdicts)).toContain('2 mutations: 1 caught, 1 survived, 0 stale, 0 equivalent');
  });

  test('never touches the repository it was pointed at', () => {
    const root = aRepository();
    const before = readFileSync(join(root, 'src', 'clamp.ts'), 'utf8');
    runMutations({ root, mutations: [killed, survivor] });
    expect(readFileSync(join(root, 'src', 'clamp.ts'), 'utf8')).toBe(before);
  });

  test('a mutation that no longer applies is stale, not caught', () => {
    const root = aRepository();
    const gone: Mutation = { ...killed, id: 'moved', find: 'if (n > 11) return 10;' };
    const verdicts = runMutations({ root, mutations: [gone] });
    expect(verdicts[0]?.outcome).toBe('stale');
    expect(acceptable(verdicts)).toBe(false);
  });

  test('a mutation that matches twice is stale too, because which one it meant is unknown', () => {
    expect(mutate('a a', { ...killed, find: 'a', replace: 'b' })).toBeUndefined();
    expect(mutate('a c', { ...killed, find: 'a', replace: 'b' })).toBe('b c');
  });

  test('an equivalent mutation is reported as such, and does not fail the run', () => {
    const root = aRepository();
    const harmless: Mutation = {
      ...survivor,
      id: 'return-n-as-is',
      find: 'return n;',
      replace: 'return n + 0;',
      equivalent: 'adding zero changes nothing',
    };
    const verdicts = runMutations({ root, mutations: [killed, harmless] });
    expect(verdicts.map((v) => v.outcome)).toEqual(['caught', 'equivalent']);
    expect(acceptable(verdicts)).toBe(true);
  });

  test('refuses to judge when the tests already fail, since a failure would then prove nothing', () => {
    const root = aRepository();
    writeFileSync(
      join(root, 'src', 'clamp.test.ts'),
      "import { test, expect } from 'bun:test';\ntest('red', () => { expect(1).toBe(2); });\n",
    );
    expect(() => runMutations({ root, mutations: [killed] })).toThrow('fail before any mutation');
  });
});
