/**
 * `tokens.json` → a model that is known to be sound, or every reason it is not.
 *
 * Everything the generator emits and every test asserts about the visual system
 * starts here, so the judgement lives in one place: a value either becomes a
 * token or the build says why it did not. **All problems are reported at once**,
 * the way the configuration loader does it — a validator that stops at the first
 * error makes fixing a file a loop of one-line failures.
 *
 * What is refused, and why each is a rule rather than a taste:
 *
 * - **A colour in only some themes.** The design tool lets a missing theme inherit
 *   the first; this does not. Inheritance is how a light theme ships with one dark
 *   panel in it.
 * - **Spacing off the 4px grid.** The grid is the claim "nothing is sized by eye".
 * - **A weight outside 400/500/600.** The system has no bold (`README` of the design
 *   system, `UX.md` §9); a 700 in the file is a 700 in the interface.
 * - **A motion longer than 200ms.** "Effectively none" (`UX.md` §9) needs a number
 *   to be checkable.
 * - **A name that is not in its family's namespace.** `space-`, `radius-`,
 *   `shadow-`, `size-`, `z-`, `stroke-`, `duration-`, `easing-` belong to their
 *   families; a colour may not use them. Every name becomes one CSS custom
 *   property in one flat namespace, so a collision is a silent override.
 */
import { Value } from '@sinclair/typebox/value';
import { TokensFile } from './schema';

/** The only weights the system has, and the Tailwind name each gets. */
export const WEIGHTS = { 400: 'normal', 500: 'medium', 600: 'semibold' } as const;
export type Weight = keyof typeof WEIGHTS;

/** What each non-colour family's token names must start with. */
const PREFIX = {
  spacing: 'space-',
  radius: 'radius-',
  shadow: 'shadow-',
  size: 'size-',
  zIndex: 'z-',
  borderWidth: 'stroke-',
  duration: 'duration-',
  easing: 'easing-',
} as const;

/** A colour token may not take a name that belongs to another family, or to the type scale. */
const RESERVED = [...Object.values(PREFIX), 'text-', 'font-'];

/** Motion is "effectively none" (`UX.md` §9): the longest transition the system allows, in ms. */
const MAX_DURATION_MS = 200;

/** The spacing grid, in px. */
const GRID = 4;

export interface Theme {
  readonly id: string;
  readonly name: string;
}

/** Where a colour's value in one theme came from: written there, or pointed at another token. */
export type ColorSource =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'alias'; readonly target: string };

export interface ColorToken {
  readonly name: string;
  readonly usage: string;
  /** The value as written, per theme. Aliases stay aliases, so the output keeps the link. */
  readonly source: Readonly<Record<string, ColorSource>>;
  /** The value after following every alias, per theme: a literal colour. */
  readonly resolved: Readonly<Record<string, string>>;
  /** `fill`: a background and a border only — never a text colour (D-110). */
  readonly role: 'any' | 'fill';
}

export interface PlainToken {
  readonly name: string;
  readonly value: string;
  readonly usage: string;
}

export interface ThemedToken {
  readonly name: string;
  readonly usage: string;
  readonly byTheme: Readonly<Record<string, string>>;
}

export interface TextStyle {
  readonly name: string;
  readonly group: string;
  readonly family: 'sans' | 'mono';
  readonly size: string;
  readonly leading: number;
  readonly weight: Weight;
  readonly tracking: string;
  readonly usage: string;
  readonly sample: string;
}

export interface Model {
  readonly name: string;
  readonly themes: readonly Theme[];
  /** The first theme: the one `:root` carries when nothing chose. */
  readonly defaultTheme: string;
  readonly colors: readonly ColorToken[];
  readonly shadows: readonly ThemedToken[];
  readonly spacing: readonly PlainToken[];
  readonly radius: readonly PlainToken[];
  readonly size: readonly PlainToken[];
  readonly zIndex: readonly PlainToken[];
  readonly borderWidth: readonly PlainToken[];
  readonly duration: readonly PlainToken[];
  readonly easing: readonly PlainToken[];
  readonly fonts: { readonly sans: string; readonly mono: string };
  readonly faces: readonly FontFace[];
  readonly text: readonly TextStyle[];
}

interface FontFace {
  readonly family: string;
  readonly weight: string;
  readonly file: string;
  readonly range: 'latin' | 'latin-ext';
}

export type Parsed =
  | { readonly ok: true; readonly model: Model }
  | { readonly ok: false; readonly problems: readonly string[] };

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;
const RGBA = /^rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), (0|1|0?\.\d{1,3})\)$/;
const ALIAS = /^\{([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\}$/;
const PX = /^(\d+)px$/;
const MS = /^(\d+)ms$/;
const EM = /^-?\d*\.?\d+em$/;
const LENGTH = '(?:0|-?\\d+px)';
const SHADOW = new RegExp(
  `^${LENGTH} ${LENGTH} ${LENGTH} ${LENGTH} (?:#[0-9a-f]{6,8}|rgba\\(\\d{1,3}, \\d{1,3}, \\d{1,3}, (?:0|1|0?\\.\\d{1,3})\\))$`,
);
const BEZIER =
  /^cubic-bezier\((0|1|0?\.\d+), (-?\d+|-?\d*\.\d+), (0|1|0?\.\d+), (-?\d+|-?\d*\.\d+)\)$/;
const STACK = /^[A-Za-z0-9 ,"_-]+$/;

const isColorLiteral = (value: string): boolean => {
  if (HEX.test(value)) return true;
  const rgba = RGBA.exec(value);
  if (rgba === null) return false;
  return [rgba[1], rgba[2], rgba[3]].every((channel) => Number(channel) <= 255);
};

const px = (value: string): number | undefined => {
  const match = PX.exec(value);
  return match === null ? undefined : Number(match[1]);
};

const isWeight = (value: number): value is Weight => value in WEIGHTS;

/**
 * Judge a parsed `tokens.json`. `raw` is whatever `JSON.parse` returned: nothing
 * about it is trusted until the schema has said so.
 */
export const parseTokens = (raw: unknown): Parsed => {
  if (!Value.Check(TokensFile, raw)) {
    const problems = [...Value.Errors(TokensFile, raw)]
      .slice(0, 25)
      .map((error) => `${error.path === '' ? '(root)' : error.path}: ${error.message}`);
    return { ok: false, problems };
  }
  const file = raw;
  const problems: string[] = [];
  const problem = (message: string): void => {
    problems.push(message);
  };

  // ---- names: one flat namespace --------------------------------------------------
  const seen = new Map<string, string>();
  const claim = (name: string, where: string): void => {
    const first = seen.get(name);
    if (first !== undefined) problem(`${where}: "${name}" is already a ${first} token`);
    else seen.set(name, where);
  };

  // ---- themes ----------------------------------------------------------------------
  const themes = file.color.themes;
  const themeIds = themes.map((theme) => theme.id);
  if (new Set(themeIds).size !== themeIds.length) problem('color.themes: ids must be unique');
  const defaultTheme = themeIds[0] ?? '';
  // The id is also the CSS `color-scheme` keyword that makes scrollbars and form
  // controls follow the theme, so it can only be one of the two the platform knows.
  for (const id of themeIds) {
    if (id !== 'dark' && id !== 'light') problem(`color.themes: "${id}" must be "dark" or "light"`);
  }

  // ---- colours ---------------------------------------------------------------------
  const writtenByName = new Map<string, Readonly<Record<string, ColorSource>>>();
  for (const token of file.color.tokens) {
    claim(token.name, 'color');
    const reserved = RESERVED.find((prefix) => token.name.startsWith(prefix));
    if (reserved !== undefined) {
      problem(`color "${token.name}": the prefix "${reserved}" belongs to another family`);
    }
    const written: Record<string, ColorSource> = {};
    const value = token.value;
    const perTheme: Record<string, string> =
      typeof value === 'string' ? Object.fromEntries(themeIds.map((id) => [id, value])) : value;
    if (typeof value !== 'string') {
      const given = Object.keys(value);
      const missing = themeIds.filter((id) => !given.includes(id));
      const extra = given.filter((id) => !themeIds.includes(id));
      if (missing.length > 0) {
        problem(
          `color "${token.name}": no value for theme ${missing.join(', ')} (a theme never inherits)`,
        );
      }
      if (extra.length > 0) problem(`color "${token.name}": unknown theme ${extra.join(', ')}`);
    } else if (!ALIAS.test(value)) {
      problem(
        `color "${token.name}": one string for every theme must be an alias like {accent}; a colour is written per theme`,
      );
    }
    for (const id of themeIds) {
      const text = perTheme[id];
      if (text === undefined) continue;
      const alias = ALIAS.exec(text);
      if (alias !== null) {
        written[id] = { kind: 'alias', target: alias[1] ?? '' };
      } else if (isColorLiteral(text)) {
        written[id] = { kind: 'literal', value: text };
      } else {
        problem(
          `color "${token.name}" (${id}): "${text}" is not #rrggbb, #rrggbbaa (lower case), rgba() or an alias`,
        );
      }
    }
    writtenByName.set(token.name, written);
  }

  const resolve = (name: string, theme: string, trail: readonly string[]): string | undefined => {
    const source = writtenByName.get(name)?.[theme];
    if (source === undefined) return undefined;
    if (source.kind === 'literal') return source.value;
    if (trail.includes(source.target)) {
      problem(`color "${name}" (${theme}): alias cycle ${[...trail, source.target].join(' → ')}`);
      return undefined;
    }
    if (!writtenByName.has(source.target)) {
      problem(`color "${name}" (${theme}): alias {${source.target}} is not a colour token`);
      return undefined;
    }
    return resolve(source.target, theme, [...trail, source.target]);
  };

  const colors: ColorToken[] = [];
  for (const token of file.color.tokens) {
    const resolved: Record<string, string> = {};
    for (const id of themeIds) {
      const value = resolve(token.name, id, [token.name]);
      if (value !== undefined) resolved[id] = value;
    }
    colors.push({
      name: token.name,
      usage: token.usage,
      source: writtenByName.get(token.name) ?? {},
      resolved,
      role: token.role ?? 'any',
    });
  }

  // ---- plain families --------------------------------------------------------------
  const plain = (
    family: keyof typeof PREFIX,
    tokens: readonly PlainToken[],
    check: (token: PlainToken) => string | undefined,
  ): readonly PlainToken[] => {
    for (const token of tokens) {
      claim(token.name, family);
      if (!token.name.startsWith(PREFIX[family])) {
        problem(`${family} "${token.name}": must start with "${PREFIX[family]}"`);
      }
      const reason = check(token);
      if (reason !== undefined) problem(`${family} "${token.name}": ${reason}`);
    }
    return tokens;
  };

  const spacing = plain('spacing', file.spacing.tokens, ({ value }) => {
    const n = px(value);
    // Zero is a step: `p-0`, `m-0` and `inset-0` exist only if the scale has one.
    if (n === undefined) return `"${value}" is not a px length`;
    return n % GRID === 0 ? undefined : `${value} is off the ${String(GRID)}px grid`;
  });
  const radius = plain('radius', file.radius.tokens, ({ name, value }) => {
    const n = px(value);
    if (n === undefined || n <= 0) return `"${value}" is not a positive px length`;
    if (name === 'radius-pill') return n === 9999 ? undefined : 'the full radius is 9999px';
    return n <= 16 ? undefined : `${value} is a pill, and only radius-pill may be one`;
  });
  const size = plain('size', file.size.tokens, ({ value }) => {
    const n = px(value);
    return n === undefined || n <= 0 ? `"${value}" is not a positive px length` : undefined;
  });
  const borderWidth = plain('borderWidth', file.borderWidth.tokens, ({ value }) => {
    // Whole pixels, except an icon's stroke, which is drawn in the icon's 24-unit grid.
    const n = /^\d+(?:\.\d+)?px$/.test(value) ? Number.parseFloat(value) : undefined;
    return n === undefined || n < 1 || n > 4 ? `"${value}" is not 1px to 4px` : undefined;
  });
  const duration = plain('duration', file.duration.tokens, ({ value }) => {
    const match = MS.exec(value);
    if (match === null) return `"${value}" is not a whole number of ms`;
    return Number(match[1]) <= MAX_DURATION_MS
      ? undefined
      : `${value} is longer than the ${String(MAX_DURATION_MS)}ms motion allows (UX §9)`;
  });
  const easing = plain('easing', file.easing.tokens, ({ value }) => {
    const match = BEZIER.exec(value);
    return match === null
      ? `"${value}" is not cubic-bezier(x1, y1, x2, y2) with x in [0, 1]`
      : undefined;
  });
  const zIndex = plain('zIndex', file.zIndex.tokens, ({ value }) =>
    /^(0|[1-9]\d{0,3})$/.test(value) ? undefined : `"${value}" is not a whole number`,
  );
  const layers = zIndex.map((token) => Number(token.value));
  layers.forEach((layer, index) => {
    const before = layers[index - 1];
    if (before !== undefined && layer <= before) {
      problem(
        `zIndex "${zIndex[index]?.name ?? ''}": layers go from lowest to highest, and no two share a value`,
      );
    }
  });

  // ---- shadows (themed) ------------------------------------------------------------
  const shadows: ThemedToken[] = [];
  for (const token of file.shadow.tokens) {
    claim(token.name, 'shadow');
    if (!token.name.startsWith(PREFIX.shadow)) {
      problem(`shadow "${token.name}": must start with "${PREFIX.shadow}"`);
    }
    const value = token.value;
    const byTheme: Record<string, string> =
      typeof value === 'string' ? Object.fromEntries(themeIds.map((id) => [id, value])) : value;
    if (typeof value !== 'string') {
      const given = Object.keys(value).sort().join(',');
      if (given !== [...themeIds].sort().join(',')) {
        problem(`shadow "${token.name}": needs exactly the themes ${themeIds.join(', ')}`);
      }
    }
    for (const [id, text] of Object.entries(byTheme)) {
      if (!SHADOW.test(text))
        problem(`shadow "${token.name}" (${id}): "${text}" is not "x y blur spread colour"`);
    }
    shadows.push({ name: token.name, usage: token.usage, byTheme });
  }

  // ---- type ------------------------------------------------------------------------
  for (const [key, stack] of Object.entries(file.type.families)) {
    if (!STACK.test(stack))
      problem(`type.families.${key}: only letters, digits, spaces, commas and quotes`);
    const generic = key === 'sans' ? 'sans-serif' : 'monospace';
    if (!stack.endsWith(generic))
      problem(`type.families.${key}: must end with the generic ${generic}`);
    if ((stack.match(/"/g) ?? []).length % 2 !== 0)
      problem(`type.families.${key}: unbalanced quotes`);
  }
  const colorNames = new Set(file.color.tokens.map((token) => token.name));
  const styleNames = new Set<string>();
  const text: TextStyle[] = [];
  for (const group of file.type.groups) {
    for (const style of group.styles) {
      if (styleNames.has(style.name)) problem(`type style "${style.name}": defined twice`);
      styleNames.add(style.name);
      // `text-ink` would be both a colour and a type style.
      if (colorNames.has(style.name))
        problem(`type style "${style.name}": the same name as a colour`);
      const size = px(style.fontSize);
      if (size === undefined || size < 11 || size > 32) {
        problem(`type style "${style.name}": font size "${style.fontSize}" is not 11px to 32px`);
      }
      if (style.lineHeight < 1.2 || style.lineHeight > 1.7) {
        problem(
          `type style "${style.name}": line height ${String(style.lineHeight)} is not 1.2 to 1.7`,
        );
      }
      if (!isWeight(style.fontWeight)) {
        problem(
          `type style "${style.name}": weight ${String(style.fontWeight)} is not 400, 500 or 600`,
        );
      }
      if (style.letterSpacing !== undefined && !EM.test(style.letterSpacing)) {
        problem(`type style "${style.name}": letter spacing "${style.letterSpacing}" is not in em`);
      }
      if (isWeight(style.fontWeight)) {
        text.push({
          name: style.name,
          group: group.name,
          family: group.family,
          size: style.fontSize,
          leading: style.lineHeight,
          weight: style.fontWeight,
          tracking: style.letterSpacing ?? '0em',
          usage: style.usage,
          sample: style.sample,
        });
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    model: {
      name: file.name,
      themes,
      defaultTheme,
      colors,
      shadows,
      spacing,
      radius,
      size,
      zIndex,
      borderWidth,
      duration,
      easing,
      fonts: file.type.families,
      faces: file.type.fonts,
      text,
    },
  };
};
