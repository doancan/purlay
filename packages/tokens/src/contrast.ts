/**
 * WCAG 2.x contrast, computed rather than claimed.
 *
 * The design system's own notes said "≥4.5:1" in prose; prose is a promise the next
 * edit breaks without anyone noticing. This is the arithmetic the build runs
 * (`pairs.ts` says which pairs, `tokens.test.ts` runs them), so a colour that stops
 * being readable stops the merge instead of waiting for a user to squint.
 *
 * Opaque colours only. A translucent colour has no contrast of its own — it has
 * the contrast of whatever it lands on — so asking for one is a mistake in the
 * table, and this refuses it rather than inventing a background.
 */

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/;

/** `#rrggbb` → channels. Throws on anything else, including `#rrggbbaa` (see above). */
const parseOpaque = (value: string): Rgb => {
  const match = HEX.exec(value);
  if (match === null) {
    throw new Error(`"${value}" is not an opaque #rrggbb colour, so it has no contrast of its own`);
  }
  const [, r = '', g = '', b = ''] = match;
  return { r: Number.parseInt(r, 16), g: Number.parseInt(g, 16), b: Number.parseInt(b, 16) };
};

const linear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance, WCAG 2.x §1.4.3. */
const luminance = ({ r, g, b }: Rgb): number =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** The ratio of the lighter to the darker, in [1, 21]. Symmetric: foreground and background may swap. */
export const contrastRatio = (a: string, b: string): number => {
  const la = luminance(parseOpaque(a));
  const lb = luminance(parseOpaque(b));
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
};
