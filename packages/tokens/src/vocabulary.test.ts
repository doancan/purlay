/**
 * The vocabulary check, shown to find what it exists to find.
 *
 * Each class here is judged by the real Tailwind against the real generated
 * theme. What is asserted is not that Tailwind works but that the *verdicts* are
 * the ones the design depends on: a token is accepted, and each way around the
 * tokens — a palette class, a bare number, a typo, a utility with a literal inside
 * it — is refused with a reason.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVocabulary, classesIn, rawValueIn, resolveStylesheet } from './vocabulary';

const directory = mkdtempSync(join(tmpdir(), 'tokens-vocabulary-'));
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** The same three imports the application makes, so the vocabulary judged is the one shipped. */
const entry = join(directory, 'entry.css');
writeFileSync(
  entry,
  `@layer theme, base, components, utilities;
@import 'tailwindcss/preflight.css' layer(base);
@import '@purlay/tokens/tokens.css' layer(theme);
@import '@purlay/tokens/theme.css';
@import 'tailwindcss/utilities.css' layer(utilities);
`,
);

const verdicts = async (...candidates: string[]): Promise<readonly string[]> =>
  await checkVocabulary({
    entry,
    resolve: resolveStylesheet,
    classes: candidates.map((candidate) => ({ file: 'x.tsx', line: 1, candidate })),
  });

describe('classes in the vocabulary', () => {
  test.each([
    'bg-surface-100',
    'text-ink',
    'text-ink-muted',
    'text-body',
    'text-code',
    'p-4',
    '-mt-2',
    'gap-2',
    'rounded-md',
    'rounded-pill',
    'shadow-float',
    'z-popover',
    'duration-collapse',
    'ease-standard',
    'transition-opacity',
    'font-medium',
    'w-sidebar',
    'max-w-feed',
    'size-icon-md',
    'h-control',
    'min-h-control',
    'h-header',
    'size-avatar',
    'h-badge',
    'min-w-badge',
    'size-dot',
    'border-hairline',
    'border-border-subtle',
    'outline-focus',
    'hover:bg-surface-200',
    'focus-visible:outline-focus',
    'max-narrow:hidden',
    'flex',
    'flex-1',
    'h-screen',
    'w-full',
    'inset-0',
    'opacity-0',
    'group',
    'group/row',
  ])('%s is accepted', async (candidate) => {
    expect(await verdicts(candidate)).toEqual([]);
  });
});

describe('classes around the vocabulary', () => {
  test.each([
    ['bg-red-500', 'builds to nothing'],
    ['bg-surfac-100', 'builds to nothing'],
    ['p-7', 'builds to nothing'],
    ['rounded-3xl', 'builds to nothing'],
    ['shadow-md', 'builds to nothing'],
    ['text-sm', 'builds to nothing'],
    ['font-bold', 'builds to nothing'],
    ['w-64', 'builds to nothing'],
    ['z-50', 'unnamed z-index'],
    ['duration-300', 'size or duration'],
    ['border', 'size or duration'],
    ['border-2', 'size or duration'],
    ['outline-2', 'size or duration'],
    ['opacity-50', 'unnamed opacity'],
    ['p-[13px]', 'size or duration'],
    ['w-[13px]', 'size or duration'],
    ['bg-[#ff0000]', 'a colour'],
    ['text-ink/50', 'a colour'],
    ['ease-[cubic-bezier(0.1,0.2,0.3,0.4)]', 'easing curve'],
  ])('%s is refused (%s)', async (candidate, reason) => {
    const found = await verdicts(candidate);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(reason);
    expect(found[0]).toContain('x.tsx:1');
  });
});

describe('judging many classes at once (#385)', () => {
  test('one raw class is reported once, against itself; the clean classes after it are not', async () => {
    const found = await checkVocabulary({
      entry,
      resolve: resolveStylesheet,
      classes: [
        { file: 'a.tsx', line: 1, candidate: 'border' },
        { file: 'b.tsx', line: 2, candidate: 'flex' },
        { file: 'c.tsx', line: 3, candidate: 'items-center' },
        { file: 'd.tsx', line: 4, candidate: 'text-ink' },
      ],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('a.tsx:1');
    expect(found[0]).toContain('border');
  });
});

describe('finding the classes', () => {
  test('reads className and the class helpers, with the line', () => {
    const uses = classesIn(
      'a.tsx',
      `const a = <div className="flex gap-2">x</div>;
const b = cn('p-4', cond && 'bg-surface-100');
const c = <p className={on ? 'text-ink' : "text-ink-muted"} />;`,
    );
    expect(uses.map((use) => [use.candidate, use.line])).toEqual([
      ['flex', 1],
      ['gap-2', 1],
      ['p-4', 2],
      ['bg-surface-100', 2],
      ['text-ink', 3],
      ['text-ink-muted', 3],
    ]);
  });

  test('reads a table of class lists by its name, so a variant component is judged too', () => {
    const uses = classesIn(
      'a.tsx',
      "const iconClasses = { sm: 'size-icon-sm shrink-0', md: 'size-icon-md' } as const;\nconst other = { a: 'not-classes' };",
    );
    expect(uses.map((use) => use.candidate)).toEqual(['size-icon-sm', 'shrink-0', 'size-icon-md']);
  });

  test('reads a constant a class position names, whatever it is called (#572)', () => {
    const uses = classesIn(
      'a.tsx',
      `const link = 'underline underline-offset-2';
const sizes = { sm: 'h-4' } as const;
const label = 'not classes';
const a = <a className={link} />;
const b = <span className={cn(sizes[size], open && 'text-ink')} title={label} />;`,
    );
    expect(uses.map((use) => [use.candidate, use.line])).toEqual([
      ['text-ink', 5],
      ['underline', 1],
      ['underline-offset-2', 1],
      ['h-4', 2],
    ]);
  });

  test('does not take prose for classes: a comment or a string anywhere else is not a class list', () => {
    const uses = classesIn(
      'a.tsx',
      `// the border and the shadow
const message = 'a shadow of a doubt';
const label = <span title="border">text</span>;`,
    );
    expect(uses).toEqual([]);
  });

  test('a comparison, and the variant handed to a style function, are not classes; the branches are', () => {
    const uses = classesIn(
      'a.tsx',
      `const a = <span className={status === 'failed' || status !== 'too-large' ? 'text-danger-text' : 'text-ink'} />;
const b = <a className={cn(buttonStyle('primary'), 'w-full')} />;
const c = <b className={cn(kind === 'note' && 'italic')} />;`,
    );
    expect(uses.map((use) => use.candidate)).toEqual([
      'text-danger-text',
      'text-ink',
      'w-full',
      'italic',
    ]);
  });

  test('a raw value in a constant a class position names is found, with its line (#572)', async () => {
    const uses = classesIn(
      'link.tsx',
      "const link = 'underline underline-offset-2';\nconst a = <a className={link} />;",
    );
    const found = await checkVocabulary({ entry, resolve: resolveStylesheet, classes: uses });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('link.tsx:1');
    expect(found[0]).toContain('underline-offset-2');
  });

  test('flags a class list assembled at runtime, which nothing can judge', async () => {
    const uses = classesIn('a.tsx', 'const a = <div className={`bg-${tone}-100 p-4`} />;');
    expect(uses).toHaveLength(1);
    const found = await checkVocabulary({ entry, resolve: resolveStylesheet, classes: uses });
    expect(found[0]).toContain('assembled at runtime');
  });
});

describe('what counts as a raw value', () => {
  test.each([
    ['color', '#fff'],
    ['background-color', 'rgb(1 2 3)'],
    ['color', 'oklch(0.5 0.1 200)'],
    ['width', '13px'],
    ['padding', '1.5rem'],
    ['transition-duration', '300ms'],
    ['transition-timing-function', 'cubic-bezier(0.4, 0, 0.2, 1)'],
    ['z-index', '50'],
    ['font-weight', '700'],
    ['line-height', '1.2'],
    ['opacity', '0.5'],
  ])('%s: %s is raw', (property, value) => {
    expect(rawValueIn(property, value)).toBeDefined();
  });

  test.each([
    ['color', 'var(--ink)'],
    ['padding', 'var(--space-4)'],
    ['width', '100%'],
    ['height', '100vh'],
    ['inset', '0'],
    ['flex', '1'],
    ['opacity', '0'],
    ['opacity', '1'],
    ['z-index', '0'],
    ['background-color', 'transparent'],
    ['font-weight', 'var(--text-body-weight)'],
    ['--tw-shadow', '0 0 #0000'],
    ['box-shadow', 'var(--tw-inset-shadow), 0 0 #0000'],
  ])('%s: %s is not', (property, value) => {
    expect(rawValueIn(property, value)).toBeUndefined();
  });
});
