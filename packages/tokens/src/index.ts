/**
 * `@purlay/tokens` — the visual vocabulary, as names.
 *
 * The values are not here. They are CSS (`tokens.css`, `theme.css`), because the
 * browser is what resolves a theme and the stylesheet is what Tailwind reads. What
 * TypeScript needs is the *names*, so that code which must refer to a token — an
 * inline SVG fill, a canvas — is checked by the compiler instead of by luck.
 */
import type { TokenName } from './generated/names';

export * from './generated/names';

// The model's shape, for tools that read tokens.json (the generator, the audit and
// whatever the design system's re-sync grows into).
export type {
  ColorSource,
  ColorToken,
  Model,
  TextStyle,
  Theme,
  ThemedToken,
  Weight,
} from './model';

/** `var(--surface-100)`: the one way code outside a stylesheet reads a token. */
export const cssVar = (name: TokenName): string => `var(--${name})`;
