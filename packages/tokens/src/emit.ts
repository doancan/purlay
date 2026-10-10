/**
 * A sound model → the three generated files.
 *
 * - `tokens.css` — CSS custom properties and nothing else. It knows no framework:
 *   anything that can read a stylesheet (Tailwind, the desktop shell, a Playwright
 *   page, an email) gets the same values from it.
 * - `theme.css` — the Tailwind binding. It maps each custom property to the name a
 *   utility is spelled with, and it is the *only* place Tailwind learns the
 *   vocabulary: the default theme is never imported, so a class that is not a
 *   token does not exist (`docs/spikes/design-tokens.md` measured this).
 * - `names.ts` — the token names as TypeScript literals, so code that must refer
 *   to one (an inline SVG, a canvas) is checked by the compiler.
 *
 * Deterministic on purpose: the output depends on the model and on nothing else,
 * in the order the file is written, so `tokens:check` can compare bytes.
 */
import type { Model, PlainToken } from './model';
import { WEIGHTS } from './model';

/**
 * Where each size token goes in Tailwind's theme. Written out rather than guessed
 * from the name: the namespace decides which utilities exist (`--container-*` is
 * `w-`, `min-w-` and `max-w-`; `--height-*` is `h-` and `min-h-`; `--size-*` is the square `size-`), and that is a
 * design decision. A token missing here, or an entry with no token, stops the
 * generator.
 */
const SIZE_BINDING: Readonly<Record<string, string | readonly string[]>> = {
  'size-sidebar': '--container-sidebar',
  'size-members': '--container-members',
  'size-feed-max': '--container-feed',
  'size-gutter': '--container-gutter',
  'size-control': '--height-control',
  'size-header': '--height-header',
  // A badge is a height and a minimum width: one digit is a circle, two are not.
  'size-badge': ['--height-badge', '--container-badge'],
  'size-code-clamp': '--height-code',
  'size-dialog': '--container-dialog',
  'size-palette': '--container-palette',
  'size-palette-list': '--height-palette-list',
  'size-toast': '--container-toast',
  'size-avatar': '--size-avatar',
  'size-dot': '--size-dot',
  'size-icon-sm': '--size-icon-sm',
  'size-icon-md': '--size-icon-md',
  'size-icon-lg': '--size-icon-lg',
  'size-focus-offset': '--outline-offset-focus',
};

/** The one size that is not a size: a viewport width, written as a literal because a media query cannot read a variable. */
const BREAKPOINT = { token: 'size-narrow', variable: '--breakpoint-narrow' } as const;

/** The icon's line is an SVG presentation property with no theme namespace, so it is a utility rather than a theme key. */
const ICON_STROKE = 'stroke-icon';

const STROKE_BINDING: Readonly<Record<string, string>> = {
  'stroke-hairline': '--border-width-hairline',
  'stroke-focus': '--outline-width-focus',
  'stroke-marker': '--border-width-marker',
};

const HEADER = `Generated from tokens.json by \`bun run tokens:generate\`. Do not edit: the build
regenerates it and fails on a difference (D-97).`;

const declaration = (name: string, value: string): string => `  ${name}: ${value};`;

const bound = (
  tokens: readonly PlainToken[],
  binding: Readonly<Record<string, string | readonly string[]>>,
  skip: readonly string[],
  family: string,
): readonly (readonly [PlainToken, string])[] => {
  const pairs: (readonly [PlainToken, string])[] = [];
  for (const token of tokens) {
    if (skip.includes(token.name)) continue;
    const target = binding[token.name];
    if (target === undefined) {
      throw new Error(`${family} "${token.name}" has no Tailwind binding in emit.ts`);
    }
    for (const one of typeof target === 'string' ? [target] : target) pairs.push([token, one]);
  }
  for (const name of Object.keys(binding)) {
    if (!tokens.some((token) => token.name === name)) {
      throw new Error(`emit.ts binds ${family} "${name}", which tokens.json does not have`);
    }
  }
  return pairs;
};

const suffix = (name: string, prefix: string): string => name.slice(prefix.length);

export type Emitted = Readonly<Record<'tokens.css' | 'theme.css' | 'names.ts', string>>;

const themeBlock = (model: Model, theme: string): string => {
  const selector =
    theme === model.defaultTheme ? `:root,\n[data-theme='${theme}']` : `[data-theme='${theme}']`;
  const lines = [`${selector} {`, declaration('color-scheme', theme)];
  for (const color of model.colors) {
    const source = color.source[theme];
    if (source === undefined) throw new Error(`color "${color.name}" has no ${theme} value`);
    lines.push(
      declaration(
        `--${color.name}`,
        source.kind === 'alias' ? `var(--${source.target})` : source.value,
      ),
    );
  }
  for (const shadow of model.shadows) {
    const value = shadow.byTheme[theme];
    if (value === undefined) throw new Error(`shadow "${shadow.name}" has no ${theme} value`);
    lines.push(declaration(`--${shadow.name}`, value));
  }
  lines.push('}');
  return lines.join('\n');
};

const emitTokensCss = (model: Model): string => {
  const blocks = model.themes.map((theme) => themeBlock(model, theme.id));
  const fixed = [':root {'];
  const family = (tokens: readonly PlainToken[]): void => {
    for (const token of tokens) fixed.push(declaration(`--${token.name}`, token.value));
  };
  family(model.spacing);
  family(model.radius);
  family(model.size);
  family(model.zIndex);
  family(model.borderWidth);
  family(model.duration);
  family(model.easing);
  fixed.push(
    declaration('--font-sans', model.fonts.sans),
    declaration('--font-mono', model.fonts.mono),
  );
  for (const [weight, name] of Object.entries(WEIGHTS))
    fixed.push(declaration(`--weight-${name}`, weight));
  for (const style of model.text) {
    const prefix = `--text-${style.name}`;
    fixed.push(
      declaration(`${prefix}-family`, `var(--font-${style.family})`),
      declaration(`${prefix}-size`, style.size),
      declaration(`${prefix}-leading`, String(style.leading)),
      declaration(`${prefix}-weight`, `var(--weight-${WEIGHTS[style.weight]})`),
      declaration(`${prefix}-tracking`, style.tracking),
    );
  }
  fixed.push('}');
  const reduced = [
    '@media (prefers-reduced-motion: reduce) {',
    '  :root {',
    ...model.duration.map((token) => `  ${declaration(`--${token.name}`, '0ms')}`),
    '  }',
    '}',
  ];
  return `/*\n * ${HEADER.split('\n').join('\n * ')}\n */\n${[...blocks, fixed.join('\n'), reduced.join('\n')].join('\n\n')}\n`;
};

const emitThemeCss = (model: Model): string => {
  const lines: string[] = [];
  const section = (title: string): void => {
    if (lines.length > 0) lines.push('');
    lines.push(`  /* ${title} */`);
  };
  /**
   * `--theme-key: var(--token)`, so a utility follows the custom property at runtime.
   *
   * **A key that would share the token's name is not a theme key at all.** Tailwind writes
   * every theme key to `:root` even under `inline`, so `--radius-md: var(--radius-md)` is
   * written after the token's own `--radius-md: 6px` and wins; a custom property that refers
   * to itself is invalid, and every radius, every icon (the SVG's own 24px) and the whole font
   * stack silently fell back to the browser's. Found in a browser, by looking: nothing that
   * does not run a cascade could have seen it. Such a name becomes a utility that reads the
   * token directly (`collisions`, below) — the same class, the same `var()`, no second
   * declaration to lose to.
   */
  const collisions: { readonly key: string; readonly token: string }[] = [];
  const map = (theme: string, source: string): void => {
    if (theme === `--${source}`) {
      collisions.push({ key: theme, token: source });
      return;
    }
    lines.push(declaration(theme, `var(--${source})`));
  };

  section('Colour: bg-, text-, border-, outline-, fill- … with the token name');
  for (const color of model.colors) map(`--color-${color.name}`, color.name);
  section('Spacing: p-, m-, gap-, inset- … (the 4px grid; there is no multiplier)');
  for (const token of model.spacing) map(`--spacing-${suffix(token.name, 'space-')}`, token.name);
  section('Radius');
  for (const token of model.radius) map(`--radius-${suffix(token.name, 'radius-')}`, token.name);
  section('Shadow (a utility: see `map`, and it differs by theme)');
  for (const shadow of model.shadows)
    map(`--shadow-${suffix(shadow.name, 'shadow-')}`, shadow.name);
  section('Sizes');
  for (const [token, target] of bound(model.size, SIZE_BINDING, [BREAKPOINT.token], 'size')) {
    map(target, token.name);
  }
  const breakpoint = model.size.find((token) => token.name === BREAKPOINT.token);
  if (breakpoint === undefined) throw new Error(`tokens.json has no ${BREAKPOINT.token}`);
  lines.push(declaration(BREAKPOINT.variable, breakpoint.value));
  section('Stroke widths');
  for (const [token, target] of bound(
    model.borderWidth,
    STROKE_BINDING,
    [ICON_STROKE],
    'borderWidth',
  )) {
    map(target, token.name);
  }
  section('Stacking: z-');
  for (const token of model.zIndex) map(`--z-index-${suffix(token.name, 'z-')}`, token.name);
  section('Motion: duration-, ease-');
  for (const token of model.duration) {
    map(`--transition-duration-${suffix(token.name, 'duration-')}`, token.name);
  }
  for (const token of model.easing) map(`--ease-${suffix(token.name, 'easing-')}`, token.name);
  section('Type: families, weights; the sizes are the text- utilities below');
  map('--font-sans', 'font-sans');
  map('--font-mono', 'font-mono');
  for (const name of Object.values(WEIGHTS)) map(`--font-weight-${name}`, `weight-${name}`);
  section('What the base layer reads');
  lines.push(
    declaration('--default-font-family', 'var(--font-sans)'),
    declaration('--default-mono-font-family', 'var(--font-mono)'),
  );

  const utilities = model.text.map((style) =>
    [
      `@utility text-${style.name} {`,
      ...(['family', 'size', 'leading', 'weight', 'tracking'] as const).map((part) => {
        const property = {
          family: 'font-family',
          size: 'font-size',
          leading: 'line-height',
          weight: 'font-weight',
          tracking: 'letter-spacing',
        }[part];
        return declaration(property, `var(--text-${style.name}-${part})`);
      }),
      '}',
    ].join('\n'),
  );
  // The names `map` could not make theme keys of, as the utility each would have been.
  for (const { key, token } of collisions) {
    const value = `var(--${token})`;
    const of = (prefix: string): string | null =>
      key.startsWith(prefix) ? key.slice(prefix.length) : null;
    const radius = of('--radius-');
    const size = of('--size-');
    const shadow = of('--shadow-');
    const font = of('--font-');
    const [name, body] =
      radius !== null
        ? [`rounded-${radius}`, declaration('border-radius', value)]
        : size !== null
          ? [`size-${size}`, `${declaration('width', value)}\n${declaration('height', value)}`]
          : shadow !== null
            ? [`shadow-${shadow}`, declaration('box-shadow', value)]
            : font !== null
              ? [`font-${font}`, declaration('font-family', value)]
              : (() => {
                  throw new Error(
                    `${key} shares a name with its token and has no utility to become`,
                  );
                })();
    utilities.push(`@utility ${name} {\n${body}\n}`);
  }
  utilities.push(
    `@utility icon-stroke {\n${declaration('stroke-width', `var(--${ICON_STROKE})`)}\n}`,
  );
  return `/*\n * ${HEADER.split('\n').join('\n * ')}\n *\n * Tailwind's default theme is never imported, so nothing exists here that is not\n * a token. \`inline\` keeps utilities pointing at the custom properties, which\n * is what lets \`[data-theme]\` change them at runtime.\n */\n@theme inline {\n${lines.join('\n')}\n}\n\n/* One class per text style sets all five properties: the style is the unit.\n * icon-stroke is the one weight an icon has. */\n${utilities.join('\n\n')}\n`;
};

const literals = (name: string, values: readonly string[]): string =>
  `export const ${name} = [\n${values.map((value) => `  '${value}',`).join('\n')}\n] as const;\n`;

const emitNamesTs = (model: Model): string => {
  const families: readonly (readonly [string, readonly string[]])[] = [
    ['themes', model.themes.map((theme) => theme.id)],
    ['colorTokens', model.colors.map((token) => token.name)],
    ['spacingTokens', model.spacing.map((token) => token.name)],
    ['radiusTokens', model.radius.map((token) => token.name)],
    ['shadowTokens', model.shadows.map((token) => token.name)],
    ['sizeTokens', model.size.map((token) => token.name)],
    ['zIndexTokens', model.zIndex.map((token) => token.name)],
    ['borderWidthTokens', model.borderWidth.map((token) => token.name)],
    ['durationTokens', model.duration.map((token) => token.name)],
    ['easingTokens', model.easing.map((token) => token.name)],
    ['textStyles', model.text.map((style) => style.name)],
  ];
  const union = [
    'colorTokens',
    'spacingTokens',
    'radiusTokens',
    'shadowTokens',
    'sizeTokens',
    'zIndexTokens',
    'borderWidthTokens',
    'durationTokens',
    'easingTokens',
  ]
    .map((name) => `(typeof ${name})[number]`)
    .join('\n  | ');
  return `// ${HEADER.split('\n').join('\n// ')}\n\n/** The theme \`:root\` carries when nothing chose one: the first in tokens.json. */\nexport const defaultTheme = '${model.defaultTheme}';\n\n${families.map(([name, values]) => literals(name, values)).join('\n')}\n/** Every token that is a CSS custom property, by name (type styles are \`text-*\` utilities). */\nexport type TokenName =\n  | ${union};\n`;
};

export const emit = (model: Model): Emitted => ({
  'tokens.css': emitTokensCss(model),
  'theme.css': emitThemeCss(model),
  'names.ts': emitNamesTs(model),
});
