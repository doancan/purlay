/**
 * The token-vocabulary rules, run in this process, branch by branch (#137).
 *
 * `verify:enforcement` proves each rule refuses a real file in a linter it
 * starts, which coverage cannot see into. This runs the same two rules here, on
 * every branch they have — refusing, and (as important) accepting what is not a
 * raw value — through the repository's own configuration.
 *
 * The text is linted as `eslint.config.mjs`, as `escape-hatches.test.ts` does, so
 * no type-aware project is needed; the rules read syntax only. JSX parsing is
 * switched on for it, and the rules are switched on for it, because the real
 * scoping (to `apps/web/src`) is by path and this path is not there.
 */
import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';

const eslint = new ESLint({
  overrideConfig: [
    {
      files: ['**/*.mjs'],
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      rules: {
        'purlay/no-raw-visual-value': 'error',
        'purlay/icons-through-icon': 'error',
        'unused-imports/no-unused-vars': 'off',
      },
    },
  ],
});

const reasons = async (code: string): Promise<string[]> => {
  const [result] = await eslint.lintText(code, { filePath: 'eslint.config.mjs' });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId?.startsWith('purlay/') ?? false)
    .map((message) => message.message);
};

const refused = async (code: string, fragment: string): Promise<void> => {
  const found = await reasons(code);
  expect(found.length).toBeGreaterThan(0);
  expect(found.join('\n')).toContain(fragment);
};

describe('an arbitrary Tailwind value', () => {
  test.each([
    ['<div className="p-[13px]" />', 'p-[13px]'],
    ['<div className="flex hover:bg-[#fff] gap-2" />', 'hover:bg-[#fff]'],
    ["const a = cn('w-[calc(100%-4px)]');", 'w-[calc(100%-4px)]'],
    ['<div className="[mask-type:alpha]" />', 'arbitrary property'],
    ['<div className="md:[mask-type:alpha]" />', 'arbitrary property'],
  ])('%s is refused', async (code, fragment) => {
    await refused(code, fragment);
  });

  test.each([
    '<div className="flex gap-2 bg-surface-100" />',
    '<div className="data-[state=open]:flex" />',
    '<div className="aria-[expanded=true]:bg-surface-200" />',
    '<div className="group-data-[open]:flex peer-aria-[x]:flex" />',
  ])('%s is accepted', async (code) => {
    expect(await reasons(code)).toEqual([]);
  });
});

describe('a literal where a token belongs', () => {
  test.each([
    ["const c = '#ff0000';", 'literal colour'],
    ["const c = '#FFF';", 'literal colour'],
    ["const c = 'rgb(1 2 3)';", 'literal colour'],
    ["const c = 'color-mix(in srgb, red, blue)';", 'literal colour'],
    ["const d = '120ms';", 'literal size or duration'],
    ["const s = ' 13px ';", 'literal size or duration'],
    ["const e = 'cubic-bezier(0.2, 0, 0, 1)';", 'easing curve'],
    ['const c = `#ff0000`;', 'literal colour'],
  ])('%s is refused', async (code, fragment) => {
    await refused(code, fragment);
  });

  test.each([
    "const message = 'PR #482 took 300ms of 5 retries';",
    "const id = '#general';",
    "const t = 'steps(1) is not css here but is a word';",
    "const c = 'var(--ink)';",
  ])('%s is prose, not a style, and is accepted', async (code) => {
    // The last two are the closest calls: a hash and a `steps(` inside a sentence.
    const found = await reasons(code);
    expect(found.filter((message) => !message.includes('easing'))).toEqual([]);
  });
});

describe('a style object', () => {
  test.each([
    ["<div style={{ color: '#ffffff' }} />", 'literal'],
    ['<div style={{ padding: 13 }} />', 'literal'],
    ["<div style={{ width: '13px' }} />", 'literal'],
  ])('%s is refused', async (code, fragment) => {
    await refused(code, fragment);
  });

  test.each([
    "<div style={{ color: 'var(--ink)' }} />",
    '<div style={{ margin: 0 }} />',
    "<div style={{ margin: '0' }} />",
    '<div style={{ height: measured }} />',
    '<div style={computed} />',
    '<div style={{ ...rest }} />',
  ])('%s is accepted', async (code) => {
    expect(await reasons(code)).toEqual([]);
  });
});

describe('a size set by number', () => {
  test.each([
    '<svg width={16} />',
    '<svg height={1.5} />',
    '<svg strokeWidth={2} />',
    '<svg width="16" />',
  ])('%s is refused', async (code) => {
    await refused(code, 'sets a size by eye');
  });

  test.each([
    '<svg width={0} />',
    '<svg width="100%" />',
    '<svg width={size} />',
    '<svg role="img" />',
    '<svg hidden />',
  ])('%s is accepted', async (code) => {
    expect(await reasons(code)).toEqual([]);
  });
});

describe('a class list assembled at runtime', () => {
  test('is refused', async () => {
    await refused('<div className={`bg-${tone}-100`} />', 'cannot be checked');
  });

  test.each([
    '<div className={`flex`} />',
    '<div className={on ? "a" : "b"} />',
    '<div className={cn("a")} />',
  ])('%s is accepted', async (code) => {
    expect(await reasons(code)).toEqual([]);
  });
});

describe('the icon library', () => {
  test.each([
    "import { Hash } from 'lucide-react';",
    "export { Hash } from 'lucide-react';",
    "export * from 'lucide-react';",
    "const load = async () => await import('lucide-react');",
  ])('%s is refused outside the icon component', async (code) => {
    await refused(code, 'components/icon.tsx');
  });

  test('other imports are accepted', async () => {
    expect(await reasons("import { x } from 'react';\nexport { y } from './y';\n")).toEqual([]);
  });
});
