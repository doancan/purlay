/**
 * The browser highlighter against the real Shiki: which names mean which grammar, what a
 * token carries, and what happens when there is nothing to say.
 */
import { describe, expect, test } from 'bun:test';
import {
  GRAMMARS,
  memoisedCore,
  browserHighlighter,
  createHighlighter,
  grammarFor,
  type Grammar,
} from './highlight';

describe('which grammar a fence names', () => {
  test.each([
    ['ts', 'typescript'],
    ['TypeScript', 'typescript'],
    ['tsx', 'tsx'],
    ['js', 'javascript'],
    ['jsx', 'javascript'],
    ['sh', 'bash'],
    ['py', 'python'],
    ['golang', 'go'],
    ['rs', 'rust'],
    ['yml', 'yaml'],
    ['md', 'markdown'],
    ['patch', 'diff'],
    ['json', 'json'],
    ['sql', 'sql'],
    ['html', 'html'],
    ['css', 'css'],
  ])('%s is %s', (name, grammar) => {
    expect<string | null>(grammarFor(name)).toBe(grammar);
  });

  test.each(['', 'cobol', 'constructor', '__proto__', 'toString'])('%j is plain', (name) => {
    expect(grammarFor(name)).toBeNull();
  });
});

describe('highlighting', () => {
  test('colours a token with a CSS variable the theme maps, never a hex, line by line', async () => {
    const lines = await browserHighlighter('const a = 1;\nreturn a', 'ts');
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(2);
    const colours = (lines ?? [])
      .flat()
      .flatMap((token) => (token.color === null ? [] : [token.color]));
    expect(colours.length).toBeGreaterThan(0);
    expect(colours.every((colour) => colour.startsWith('var(--shiki-'))).toBe(true);
    expect((lines ?? []).map((line) => line.map((t) => t.content).join(''))).toEqual([
      'const a = 1;',
      'return a',
    ]);
  });

  test('loads a language once and can be asked again', async () => {
    const first = await browserHighlighter('x = 1', 'python');
    const second = await browserHighlighter('y = 2', 'py');
    expect(first?.[0]?.length).toBeGreaterThan(0);
    expect(second?.[0]?.length).toBeGreaterThan(0);
  });

  test('an unknown language is null: the block stays plain', async () => {
    expect(await browserHighlighter('anything', 'cobol')).toBeNull();
  });

  test('fontStyle becomes flags a component can use', async () => {
    const lines = await browserHighlighter('# note', 'bash');
    const flags = (lines ?? []).flat().map((t) => [t.italic, t.bold]);
    expect(
      flags.every(([italic, bold]) => typeof italic === 'boolean' && typeof bold === 'boolean'),
    ).toBe(true);
  });

  test.each(Object.keys(GRAMMARS) as Grammar[])(
    '%s loads and colours something',
    async (grammar) => {
      const lines = await browserHighlighter('x', grammar);
      expect(lines?.[0]?.length).toBeGreaterThan(0);
    },
  );

  test('a grammar that fails to load leaves the block plain, and the next one still works', async () => {
    const broken = createHighlighter({
      ...GRAMMARS,
      yaml: () => Promise.reject(new Error('the chunk did not arrive')),
    });
    expect(await broken('a: 1', 'yaml')).toBeNull();
    expect((await broken('SELECT 1', 'sql'))?.length).toBe(1);
  });
});

describe('the highlighter core', () => {
  test('a load that failed is asked for again, not remembered as failed for the life of the page', async () => {
    let asks = 0;
    const real = browserHighlighter;
    const core = memoisedCore(() => {
      asks += 1;
      return asks === 1
        ? Promise.reject(new Error('the chunk did not arrive'))
        : Promise.reject(new Error('still down'));
    });
    const flaky = createHighlighter(GRAMMARS, core);
    expect(await flaky('SELECT 1', 'sql')).toBeNull();
    expect(await flaky('SELECT 1', 'sql')).toBeNull();
    expect(asks).toBe(2);
    expect(await real('SELECT 1', 'sql')).not.toBeNull();
  });

  test('a load that worked is kept: one core for every block', async () => {
    let asks = 0;
    const loaded = memoisedCore(() => {
      asks += 1;
      return Promise.resolve({} as never);
    });
    await loaded();
    await loaded();
    expect(asks).toBe(1);
  });
});
