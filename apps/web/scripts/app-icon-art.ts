/**
 * The Purlay mark as the pictures of the web application draw it (D-339). Pure functions, so that
 * `scripts/app-icons.ts` writes the pictures and `src/favicon.test.ts` can require that what is
 * committed is exactly what this makes from `public/purlay-mark.svg`: a hand edit of a picture, or a
 * new mark that was not drawn again, fails there.
 *
 * The brand file is the owner's artwork: gradient paths on a transparent ground. A tab strip, a launcher
 * and a Home Screen each put it on a ground of their own, so the pictures give it one: a white tile, the
 * `on-accent` token (bound in `favicon.test.ts`, as every colour a browser reads outside the document is).
 */

/** The tile the mark sits on: the `on-accent` token, which is white in every theme. */
const TILE = '#ffffff';

/** The tile's corner radius in the 1024 box: the 7 of 32 the favicon has always had. */
const RADIUS = 224;

/**
 * How far the mark is drawn up from the brand file. Its farthest point is 386.7 from the centre of the
 * box; a launcher's safe zone for a maskable picture is a circle of 409.6 (80 percent), so 1.04 keeps
 * it inside at 402, as large as it can be. `src/app-icons.test.ts` measures it on the PNGs.
 */
const MARK_SCALE = 1.04;

/**
 * The dot of D-148: the colour of `danger` in the light theme, ringed in the tile's colour so that it
 * stands off the mark, at the top right where the mark leaves room.
 */
const DOT = { x: 820, y: 204, ring: 215, fill: 160, colour: '#ef4444' } as const;

/** The only elements the brand file may contain: it ships on every page load, so it carries nothing active. */
const ALLOWED_ELEMENTS = new Set(['svg', 'defs', 'linearGradient', 'stop', 'g', 'path']);

export interface Mark {
  /** The gradients, as the brand file declares them, on one line. */
  readonly defs: string;
  /** The shapes, on one line. */
  readonly shapes: string;
}

const oneLine = (markup: string): string => markup.replace(/>\s+</g, '><').trim();

/** The gradients and shapes of the brand file; a file with anything else in it is refused, not cleaned. */
export const readMark = (svg: string): Mark => {
  const elements = new Set(
    [...svg.matchAll(/<\/?([A-Za-z][\w:-]*)/g)].map((match) => match[1] ?? ''),
  );
  for (const element of elements) {
    if (!ALLOWED_ELEMENTS.has(element)) {
      throw new Error(
        `public/purlay-mark.svg has a <${element}>: only ${[...ALLOWED_ELEMENTS].join(', ')} are drawn`,
      );
    }
  }
  if (/\s(?:on\w+|href|xlink:href|style)\s*=/i.test(svg) || /url\((?!#)/i.test(svg)) {
    throw new Error(
      'public/purlay-mark.svg refers to something outside itself or carries a handler',
    );
  }
  const defs = /<defs>[\s\S]*?<\/defs>/.exec(svg)?.[0];
  const shapes = /<g>([\s\S]*?)<\/g>/.exec(svg)?.[1];
  if (defs === undefined || shapes === undefined) {
    throw new Error('public/purlay-mark.svg is expected to have <defs> and one <g> of paths');
  }
  return { defs: oneLine(defs), shapes: oneLine(shapes) };
};

/** `public/favicon.svg`: the mark on its tile. */
export const favicon = (mark: Mark): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
  `<rect width="1024" height="1024" rx="${String(RADIUS)}" fill="${TILE}"/>` +
  mark.defs +
  `<g transform="translate(512 512) scale(${String(MARK_SCALE)}) translate(-512 -512)">${mark.shapes}</g>` +
  `</svg>\n`;

/** `public/favicon-waiting.svg`: the favicon, drawn the same, with the dot over it (D-148). */
export const waitingFavicon = (mark: Mark): string =>
  favicon(mark).replace(
    '</svg>\n',
    `<circle cx="${String(DOT.x)}" cy="${String(DOT.y)}" r="${String(DOT.ring)}" fill="${TILE}"/>` +
      `<circle cx="${String(DOT.x)}" cy="${String(DOT.y)}" r="${String(DOT.fill)}" fill="${DOT.colour}"/>` +
      `</svg>\n`,
  );

/** The favicon without its rounding: the launcher or iOS cuts its own shape. */
export const fullBleed = (svg: string): string => svg.replace(/ rx="[^"]*"/, '');
