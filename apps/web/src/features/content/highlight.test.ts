/**
 * The browser highlighter against the real Shiki: which names mean which grammar, what a
 * token carries, and what happens when there is nothing to say.
 */
import { describe, expect, test } from 'bun:test';
import { browserHighlighter, grammarFor } from './highlight';

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
});
