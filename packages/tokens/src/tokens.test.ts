/**
 * The token file is judged, and the judge is seen to refuse.
 *
 * Every rule `model.ts` and `audit.ts` state is planted here in a copy of the real
 * file and must turn the verdict red — a validator that has only ever been run on
 * a good file is a validator nobody has seen work (`CONTRIBUTING.md` §6.4). The
 * untouched copy must stay green, or "red" would mean nothing either.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { audit } from './audit';
import { contrastRatio } from './contrast';
import { emit } from './emit';
import { parseTokens, type Model } from './model';
import { EXEMPT, PAIRS } from './pairs';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const source: unknown = JSON.parse(read('../tokens.json'));

/** A deep copy of the real file that a test may damage. */
const copy = (): Record<string, unknown> => {
  const clone: unknown = structuredClone(source);
  if (typeof clone !== 'object' || clone === null || Array.isArray(clone))
    throw new Error('not an object');
  return Object.fromEntries(Object.entries(clone));
};

const sound = (): Model => {
  const parsed = parseTokens(source);
  if (!parsed.ok)
    throw new Error(`the real tokens.json is not sound:\n${parsed.problems.join('\n')}`);
  return parsed.model;
};

/** Edit a family's token in a copy: `damage(file, 'spacing', 'space-1', { value: '5px' })`. */
const damage = (
  file: Record<string, unknown>,
  family: string,
  token: string,
  change: Record<string, unknown>,
): void => {
  const group: unknown = family === 'color' ? file['color'] : file[family];
  if (
    typeof group !== 'object' ||
    group === null ||
    !('tokens' in group) ||
    !Array.isArray(group.tokens)
  ) {
    throw new Error(`no family ${family}`);
  }
  const found: unknown = group.tokens.find(
    (entry: unknown) =>
      typeof entry === 'object' && entry !== null && 'name' in entry && entry.name === token,
  );
  if (typeof found !== 'object' || found === null)
    throw new Error(`no token ${token} in ${family}`);
  Object.assign(found, change);
};

const problemsOf = (file: unknown): readonly string[] => {
  const parsed = parseTokens(file);
  return parsed.ok ? [] : parsed.problems;
};

describe('the real token file', () => {
  test('is sound', () => {
    expect(problemsOf(source)).toEqual([]);
  });

  test('is readable: every pair in pairs.ts meets its ratio in every theme, and every colour is decided', () => {
    expect(audit(sound())).toEqual([]);
  });

  test('has every theme complete, and dark first: black, the light one, and Midnight (D-184)', () => {
    const model = sound();
    expect(model.themes.map((theme) => theme.id)).toEqual(['dark', 'light', 'midnight']);
    expect(model.defaultTheme).toBe('dark');
    for (const color of model.colors) {
      expect(Object.keys(color.resolved).sort()).toEqual(['dark', 'light', 'midnight']);
    }
  });

  test('draws Midnight dark: it is a dark theme for the platform’s scrollbars and form controls', () => {
    const css = emit(sound())['tokens.css'];
    const midnight = css.slice(css.indexOf("[data-theme='midnight']"));
    expect(midnight.slice(0, midnight.indexOf('}'))).toContain('color-scheme: dark;');
  });

  test('carries no contrast figure in prose: the table owns the numbers', () => {
    for (const color of sound().colors) {
      expect(color.usage).not.toMatch(/≥|\d+(?:\.\d+)?:1/);
    }
  });
});

describe('the committed generated files', () => {
  test('are exactly what the source produces', () => {
    const files = emit(sound());
    expect(read('./generated/tokens.css')).toBe(files['tokens.css']);
    expect(read('./generated/theme.css')).toBe(files['theme.css']);
    expect(read('./generated/names.ts')).toBe(files['names.ts']);
  });

  test('are deterministic', () => {
    expect(emit(sound())).toEqual(emit(sound()));
  });
});

describe('the validator refuses', () => {
  test('a spacing step off the 4px grid', () => {
    const file = copy();
    damage(file, 'spacing', 'space-1', { value: '5px' });
    expect(problemsOf(file).join('\n')).toContain('off the 4px grid');
  });

  test('a weight the system does not have', () => {
    const file = copy();
    const type = file['type'];
    if (
      typeof type !== 'object' ||
      type === null ||
      !('groups' in type) ||
      !Array.isArray(type.groups)
    ) {
      throw new Error('no type groups');
    }
    const first: unknown = type.groups[0];
    if (
      typeof first !== 'object' ||
      first === null ||
      !('styles' in first) ||
      !Array.isArray(first.styles)
    ) {
      throw new Error('no styles');
    }
    Object.assign(first.styles[0], { fontWeight: 700 });
    expect(problemsOf(file).join('\n')).toContain('is not 400, 500 or 600');
  });

  test('a motion longer than the system allows', () => {
    const file = copy();
    damage(file, 'duration', 'duration-collapse', { value: '300ms' });
    expect(problemsOf(file).join('\n')).toContain('longer than the 200ms');
  });

  test('a colour that is missing from one theme', () => {
    const file = copy();
    damage(file, 'color', 'ink', { value: { dark: '#e6e8eb' } });
    expect(problemsOf(file).join('\n')).toContain('no value for theme light');
  });

  test('a colour that is not in the accepted forms', () => {
    const file = copy();
    damage(file, 'color', 'ink', { value: { dark: 'red', midnight: 'red', light: '#111418' } });
    expect(problemsOf(file).join('\n')).toContain('"red" is not');
  });

  test('upper-case hex, which would make two spellings of one colour', () => {
    const file = copy();
    damage(file, 'color', 'ink', {
      value: { dark: '#E6E8EB', midnight: '#E6E8EB', light: '#111418' },
    });
    expect(problemsOf(file).join('\n')).toContain('lower case');
  });

  test('an alias to a colour that does not exist', () => {
    const file = copy();
    damage(file, 'color', 'focus-ring', { value: '{no-such-colour}' });
    expect(problemsOf(file).join('\n')).toContain('is not a colour token');
  });

  test('an alias cycle', () => {
    const file = copy();
    damage(file, 'color', 'danger-text', {
      value: { dark: '{focus-ring}', midnight: '{focus-ring}', light: '#b91c1c' },
    });
    damage(file, 'color', 'focus-ring', { value: '{danger-text}' });
    expect(problemsOf(file).join('\n')).toContain('alias cycle');
  });

  test('one string for every theme that is not an alias', () => {
    const file = copy();
    damage(file, 'color', 'ink', { value: '#e6e8eb' });
    expect(problemsOf(file).join('\n')).toContain('must be an alias');
  });

  test('a name used twice', () => {
    const file = copy();
    damage(file, 'spacing', 'space-2', { name: 'space-1' });
    expect(problemsOf(file).join('\n')).toContain('"space-1" is already a spacing token');
  });

  test('a colour wearing another family’s prefix', () => {
    const file = copy();
    damage(file, 'color', 'scrim', { name: 'space-scrim' });
    expect(problemsOf(file).join('\n')).toContain('belongs to another family');
  });

  test('a token outside its family’s namespace', () => {
    const file = copy();
    damage(file, 'radius', 'radius-sm', { name: 'corner-sm' });
    expect(problemsOf(file).join('\n')).toContain('must start with "radius-"');
  });

  test('layers that do not go from lowest to highest', () => {
    const file = copy();
    damage(file, 'zIndex', 'z-popover', { value: '5' });
    expect(problemsOf(file).join('\n')).toContain('lowest to highest');
  });

  test('a pill radius that is not radius-pill', () => {
    const file = copy();
    damage(file, 'radius', 'radius-md', { value: '40px' });
    expect(problemsOf(file).join('\n')).toContain('only radius-pill may be one');
  });

  test('a shadow that is not "x y blur spread colour"', () => {
    const file = copy();
    damage(file, 'shadow', 'shadow-float', { value: 'big' });
    expect(problemsOf(file).join('\n')).toContain('is not "x y blur spread colour"');
  });

  test('an easing curve outside [0, 1] on the time axis', () => {
    const file = copy();
    damage(file, 'easing', 'easing-standard', { value: 'cubic-bezier(2, 0, 0, 1)' });
    expect(problemsOf(file).join('\n')).toContain('cubic-bezier');
  });

  test('a font that is a URL rather than a file this app serves, so no third party is asked', () => {
    const file = copy();
    const type = file['type'];
    if (typeof type !== 'object' || type === null) throw new Error('no type');
    Object.assign(type, {
      fonts: [
        {
          family: 'Inter',
          file: 'https://fonts.example/Inter.woff2',
          weight: '400',
          range: 'latin',
        },
      ],
    });
    expect(problemsOf(file)).not.toEqual([]);
  });

  test('a family nothing generates anything from', () => {
    const file = copy();
    file['opacity'] = { tokens: [{ name: 'opacity-dim', value: '0.5', usage: 'x' }] };
    expect(problemsOf(file)).not.toEqual([]);
  });

  test('a type style named like a colour', () => {
    const file = copy();
    const type = file['type'];
    if (
      typeof type !== 'object' ||
      type === null ||
      !('groups' in type) ||
      !Array.isArray(type.groups)
    ) {
      throw new Error('no type groups');
    }
    const group: unknown = type.groups[0];
    if (
      typeof group !== 'object' ||
      group === null ||
      !('styles' in group) ||
      !Array.isArray(group.styles)
    ) {
      throw new Error('no styles');
    }
    Object.assign(group.styles[0], { name: 'ink' });
    expect(problemsOf(file).join('\n')).toContain('the same name as a colour');
  });

  test('a theme that is none of dark, light or midnight', () => {
    const file = copy();
    const color = file['color'];
    if (typeof color !== 'object' || color === null) throw new Error('no color');
    Object.assign(color, {
      themes: [
        { id: 'dark', name: 'Dark' },
        { id: 'sepia', name: 'Sepia' },
      ],
    });
    expect(problemsOf(file).join('\n')).toContain('must be "dark", "light" or "midnight"');
  });

  test('and reports every problem at once, not the first', () => {
    const file = copy();
    damage(file, 'spacing', 'space-1', { value: '5px' });
    damage(file, 'duration', 'duration-collapse', { value: '300ms' });
    expect(problemsOf(file).length).toBeGreaterThanOrEqual(2);
  });
});

describe('the audit refuses', () => {
  test('a Midnight colour that has stopped being readable, as it does a dark or a light one (D-184)', () => {
    const file = copy();
    damage(file, 'color', 'ink-muted', {
      value: { dark: '#a9a9b1', midnight: '#2a2f36', light: '#5a626e' },
    });
    const parsed = parseTokens(file);
    if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
    expect(audit(parsed.model).join('\n')).toContain('ink-muted on surface-100 (midnight)');
  });

  test('a colour that has stopped being readable', () => {
    const file = copy();
    damage(file, 'color', 'ink-muted', {
      value: { dark: '#2a2f36', midnight: '#2a2f36', light: '#5a626e' },
    });
    const parsed = parseTokens(file);
    if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
    expect(audit(parsed.model).join('\n')).toContain('ink-muted on surface-100 (dark)');
  });

  test('a colour nobody decided anything about', () => {
    const file = copy();
    const color = file['color'];
    if (
      typeof color !== 'object' ||
      color === null ||
      !('tokens' in color) ||
      !Array.isArray(color.tokens)
    ) {
      throw new Error('no colors');
    }
    color.tokens.push({
      name: 'brand-new',
      value: { dark: '#ffffff', light: '#000000', midnight: '#ffffff' },
      usage: 'x',
    });
    const parsed = parseTokens(file);
    if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
    expect(audit(parsed.model).join('\n')).toContain('colour "brand-new" has no contrast decision');
  });

  test('a translucent colour in a pair, which has no contrast of its own', () => {
    const file = copy();
    damage(file, 'color', 'ink', {
      value: { dark: '#e6e8eb80', midnight: '#e6e8eb80', light: '#111418' },
    });
    const parsed = parseTokens(file);
    if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
    expect(audit(parsed.model).join('\n')).toContain('no contrast of its own');
  });
});

describe('the audit also refuses', () => {
  test('a pair that names a colour the file no longer has', () => {
    const file = copy();
    const color = file['color'];
    if (
      typeof color !== 'object' ||
      color === null ||
      !('tokens' in color) ||
      !Array.isArray(color.tokens)
    ) {
      throw new Error('no colors');
    }
    color.tokens = color.tokens.filter(
      (entry: unknown) =>
        !(
          typeof entry === 'object' &&
          entry !== null &&
          'name' in entry &&
          entry.name === 'syntax-keyword'
        ),
    );
    const parsed = parseTokens(file);
    if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
    expect(audit(parsed.model).join('\n')).toContain('lacks one of them');
  });

  test('an exemption for a colour that is not there', () => {
    const file = copy();
    const color = file['color'];
    if (
      typeof color !== 'object' ||
      color === null ||
      !('tokens' in color) ||
      !Array.isArray(color.tokens)
    ) {
      throw new Error('no colors');
    }
    color.tokens = color.tokens.filter(
      (entry: unknown) =>
        !(typeof entry === 'object' && entry !== null && 'name' in entry && entry.name === 'scrim'),
    );
    const parsed = parseTokens(file);
    if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
    expect(audit(parsed.model).join('\n')).toContain('EXEMPT names "scrim"');
  });
});

describe('contrast', () => {
  test('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // The textbook just-failing grey on white.
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  test('is symmetric', () => {
    expect(contrastRatio('#0d0f12', '#e6e8eb')).toBe(contrastRatio('#e6e8eb', '#0d0f12'));
  });

  test('the table asks about colours that exist, and its exemptions are real', () => {
    const names = new Set(sound().colors.map((color) => color.name));
    for (const pair of PAIRS) {
      expect(names.has(pair.foreground)).toBe(true);
      expect(names.has(pair.background)).toBe(true);
    }
    for (const name of Object.keys(EXEMPT)) expect(names.has(name)).toBe(true);
  });
});

describe('the generated CSS', () => {
  const files = emit(sound());

  test('carries the default theme on :root and the light theme after it, so the later block wins', () => {
    const css = files['tokens.css'];
    expect(css.indexOf(":root,\n[data-theme='dark']")).toBeGreaterThan(-1);
    expect(css.indexOf("[data-theme='light']")).toBeGreaterThan(css.indexOf("[data-theme='dark']"));
    expect(css).toContain('color-scheme: dark;');
    expect(css).toContain('color-scheme: light;');
  });

  test('keeps an alias an alias, so the link survives a change to its target', () => {
    expect(files['tokens.css']).toContain('--focus-ring: var(--accent-text);');
    expect(files['tokens.css']).toContain('--danger-text: var(--danger);');
  });

  test('turns every motion off under prefers-reduced-motion', () => {
    const css = files['tokens.css'];
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const token of sound().duration) expect(block).toContain(`--${token.name}: 0ms;`);
  });

  test('defines every themed property in every theme, so no theme inherits another’s value', () => {
    const css = files['tokens.css'];
    const at = (id: string): number => css.indexOf(`[data-theme='${id}']`);
    const dark = css.slice(0, at('light'));
    const light = css.slice(at('light'), at('midnight'));
    const midnight = css.slice(at('midnight'), css.indexOf(':root {'));
    for (const color of sound().colors) {
      expect(dark).toContain(`--${color.name}:`);
      expect(light).toContain(`--${color.name}:`);
      expect(midnight).toContain(`--${color.name}:`);
    }
  });

  test('never imports Tailwind’s default theme: only the binding defines the vocabulary', () => {
    expect(files['theme.css']).toContain('@theme inline {');
    expect(files['theme.css']).not.toContain('@theme default');
    expect(files['theme.css']).not.toContain('tailwindcss');
  });

  /**
   * Found in a browser, by looking, and by no test that ran before it: Tailwind writes every
   * theme key to `:root` even under `inline`, so `--radius-md: var(--radius-md)` was written
   * after the token's own `--radius-md: 6px`, won, and — a custom property that refers to
   * itself being invalid — every radius, every icon and the whole font stack fell back to the
   * browser's. Class-compiling tests cannot see a cascade. A name shared by a theme key and a
   * token is therefore a utility that reads the token, never a key.
   */
  test('has no theme key that refers to itself', () => {
    const itself = [...files['theme.css'].matchAll(/^\s*(--[\w-]+):\s*var\(\1\)/gm)].map(
      (match) => match[1],
    );
    expect(itself).toEqual([]);
  });

  test('writes what shares a name with its token as the utility that reads it', () => {
    const css = files['theme.css'];
    for (const utility of [
      ['rounded-md', 'border-radius: var(--radius-md)'],
      ['size-icon-sm', 'width: var(--size-icon-sm)'],
      ['shadow-float', 'box-shadow: var(--shadow-float)'],
      ['font-mono', 'font-family: var(--font-mono)'],
    ] as const) {
      expect(css).toContain(`@utility ${utility[0]} {\n  ${utility[1]};`);
    }
    expect(css).not.toMatch(/^\s*--(?:radius|shadow|font)-(?:md|float|mono|sans|sm):/m);
  });

  test('writes the viewport width as a literal, because a media query cannot read a variable', () => {
    expect(files['theme.css']).toContain('--breakpoint-narrow: 900px;');
  });

  test('is refused when a size has no Tailwind binding', () => {
    const file = copy();
    const size = file['size'];
    if (
      typeof size !== 'object' ||
      size === null ||
      !('tokens' in size) ||
      !Array.isArray(size.tokens)
    ) {
      throw new Error('no sizes');
    }
    size.tokens.push({ name: 'size-sheet', value: '320px', usage: 'x' });
    const parsed = parseTokens(file);
    if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
    expect(() => emit(parsed.model)).toThrow('no Tailwind binding');
  });
});
