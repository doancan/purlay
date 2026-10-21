/**
 * The pull-request rules, refusing and accepting (#126).
 */
import { describe, expect, test } from 'bun:test';
import {
  FAILURE_MODES,
  judge,
  linkedIssues,
  OVERRIDE_LABEL,
  PRODUCTION_LINE_BUDGET,
  productionLines,
  type ChangedFile,
  type PullRequest,
  unansweredFailureModes,
} from './check-pull-request';

const file = (path: string, lines: number): ChangedFile => ({
  path,
  additions: lines,
  deletions: 0,
});

/** A section that answers every category, as an author fills the template in. */
const answered = [
  '## Failure modes',
  '',
  ...FAILURE_MODES.map((mode) => `- **${mode}:** covered by x.test.ts`),
].join('\n');

const aPull = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  body: `Closes #1.\n\n${answered}`,
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
    expect(judge(aPull({ body: `Mentions #7 in passing.\n\n${answered}` }), labelled({}))).toEqual([
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
      body: `Closes #1. Part of #2.\n\n${answered}`,
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

describe('a pull request says how it fails (CONTRIBUTING.md §6.9)', () => {
  test('every category answered, one line each, passes', () => {
    expect(unansweredFailureModes(answered)).toEqual([]);
  });

  test('without the section, every category is unanswered', () => {
    expect(unansweredFailureModes('Closes #1.')).toEqual([...FAILURE_MODES]);
  });

  test('the template left as it is answers nothing', () => {
    const template = [
      '## Failure modes',
      '',
      '<!-- One line each: the test that covers it, or why it cannot apply. -->',
      '',
      ...FAILURE_MODES.map((mode) => `- **${mode}:** `),
    ].join('\n');
    expect(unansweredFailureModes(template)).toEqual([...FAILURE_MODES]);
  });

  test('an answer hidden in a comment is not an answer', () => {
    const body = answered.replace(
      '- **Volume:** covered by x.test.ts',
      '<!--\n- **Volume:** later\n-->',
    );
    expect(unansweredFailureModes(body)).toEqual(['Volume']);
  });

  test('a category answered under another heading does not count', () => {
    const body = `## Failure modes\n\n- **Authority:** 404 test\n\n## Notes\n\n- **Volume:** fine`;
    expect(unansweredFailureModes(body)).toEqual(
      FAILURE_MODES.filter((mode) => mode !== 'Authority'),
    );
  });

  test('plain "Label: answer" lines count, case aside', () => {
    const body = [
      '## Failure modes',
      ...FAILURE_MODES.map((m) => `${m.toLowerCase()}: n/a, no input`),
    ].join('\n');
    expect(unansweredFailureModes(body)).toEqual([]);
  });

  test('a change to production code without it is refused, naming what is missing', () => {
    expect(judge(aPull({ body: 'Closes #1.' }), labelled({ 1: ['api'] }))).toEqual([
      expect.stringContaining('Refused input, Authority') as string,
    ]);
  });

  test('documents and tests alone owe no failure modes', () => {
    const pull = aPull({
      body: 'Closes #1.',
      files: [file('docs/UX.md', 5), file('apps/api/src/x.test.ts', 50)],
    });
    expect(judge(pull, labelled({ 1: ['api'] }))).toEqual([]);
  });
});
