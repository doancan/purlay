/**
 * The pull-request rules, refusing and accepting (#126).
 */
import { describe, expect, test } from 'bun:test';
import {
  judge,
  linkedIssues,
  OVERRIDE_LABEL,
  PRODUCTION_LINE_BUDGET,
  productionLines,
  type ChangedFile,
  type PullRequest,
} from './check-pull-request';

const file = (path: string, lines: number): ChangedFile => ({
  path,
  additions: lines,
  deletions: 0,
});

const aPull = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  body: 'Closes #1.',
  author: 'someone',
  labels: [],
  files: [file('apps/api/src/platform/clock.ts', 10)],
  ...overrides,
});

const labelled = (entries: Record<number, string[]>): Map<number, string[]> =>
  new Map(Object.entries(entries).map(([issue, labels]) => [Number(issue), labels]));

describe('a pull request names its task', () => {
  test('every closing keyword and "Part of" count, case aside, each issue once', () => {
    expect(
      linkedIssues('Closes #1, fixes #2. Resolved #3; part of #4 and Part Of #4. See #5.'),
    ).toEqual([1, 2, 3, 4]);
  });

  test('one that names none is refused', () => {
    expect(judge(aPull({ body: 'Mentions #7 in passing.' }), labelled({}))).toEqual([
      expect.stringContaining('names no issue') as string,
    ]);
  });

  test('dependabot is the one author excused', () => {
    expect(judge(aPull({ body: '', author: 'app/dependabot' }), labelled({}))).toEqual([]);
  });
});

describe('a pull request fits the budget', () => {
  test('tests, documents and generated files are not counted', () => {
    expect(
      productionLines([
        file('apps/api/src/x.ts', 10),
        file('apps/api/src/x.test.ts', 500),
        file('apps/api/src/x.integration.test.ts', 500),
        file('docs/DECISIONS.md', 500),
        file('bun.lock', 500),
        file('packages/db/src/schema.ts', 500),
        file('apps/api/package.json', 3),
      ]),
    ).toBe(10);
  });

  test('at the budget it passes; one line over it is refused', () => {
    const at = aPull({ files: [file('apps/api/src/x.ts', PRODUCTION_LINE_BUDGET)] });
    const over = aPull({ files: [file('apps/api/src/x.ts', PRODUCTION_LINE_BUDGET + 1)] });
    expect(judge(at, labelled({ 1: ['api'] }))).toEqual([]);
    expect(judge(over, labelled({ 1: ['api'] }))).toEqual([
      expect.stringContaining(`the budget is ${String(PRODUCTION_LINE_BUDGET)}`) as string,
    ]);
  });

  test('over budget passes with the override label, and only with it', () => {
    const over = aPull({
      files: [file('apps/api/src/x.ts', PRODUCTION_LINE_BUDGET + 1)],
      labels: [OVERRIDE_LABEL],
    });
    expect(judge(over, labelled({ 1: ['api'] }))).toEqual([]);
  });
});

describe('a pull request touches what its task is about', () => {
  test('a web task touching the API is refused, naming the file', () => {
    const pull = aPull({ files: [file('apps/web/src/a.tsx', 5), file('apps/api/src/b.ts', 5)] });
    expect(judge(pull, labelled({ 1: ['web'] }))).toEqual([
      expect.stringContaining('apps/api/src/b.ts') as string,
    ]);
  });

  test('the same change passes when it names the issue the other file serves', () => {
    const pull = aPull({
      body: 'Closes #1. Part of #2.',
      files: [file('apps/web/src/a.tsx', 5), file('apps/api/src/b.ts', 5)],
    });
    expect(judge(pull, labelled({ 1: ['web'], 2: ['api'] }))).toEqual([]);
  });

  test('a cross-cutting task restricts nothing', () => {
    const pull = aPull({ files: [file('apps/web/src/a.tsx', 5), file('eslint.config.mjs', 5)] });
    expect(judge(pull, labelled({ 1: ['web', 'infra'] }))).toEqual([]);
  });

  test('documents and tests are part of every task', () => {
    const pull = aPull({
      files: [
        file('apps/web/src/a.tsx', 5),
        file('docs/UX.md', 5),
        file('apps/web/src/a.test.tsx', 5),
      ],
    });
    expect(judge(pull, labelled({ 1: ['web'] }))).toEqual([]);
  });

  test('a documentation task touching code is refused', () => {
    expect(judge(aPull(), labelled({ 1: ['docs'] }))).toEqual([
      expect.stringContaining('apps/api/src/platform/clock.ts') as string,
    ]);
  });
});
