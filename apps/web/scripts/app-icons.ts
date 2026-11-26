/**
 * Draw the web icons from the supplied Purlay mark (D-148, D-230). Run `bun run icons` to
 * regenerate both favicons and all four PNGs.
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

interface ColourToken {
  readonly name: string;
  readonly value: string | Readonly<Record<string, string>>;
}

const tokens = (
  JSON.parse(
    readFileSync(new URL('../../../packages/tokens/tokens.json', import.meta.url), 'utf8'),
  ) as { readonly color: { readonly tokens: readonly ColourToken[] } }
).color.tokens;

const darkColour = (name: string): string => {
  const value = tokens.find((token) => token.name === name)?.value;
  const colour = typeof value === 'string' ? value : value?.['dark'];
  if (colour === undefined) throw new Error(`Missing dark colour token: ${name}`);
  return colour;
};

const PUBLIC = new URL('../public/', import.meta.url);
const source = readFileSync(new URL('purlay.svg', import.meta.url), 'utf8').trim();
const mark = source.replace(/^<svg[^>]*>\n/, '').replace(/\n<\/svg>$/, '');
const surface = darkColour('surface-100');
const ring = darkColour('on-accent');
const danger = darkColour('danger');

const wrap = (art: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
${art}
</svg>
`;

const art = (rounded: boolean): string => {
  // The platform crops the full-bleed icons to its own shape. Keep their mark
  // inside the central circle of radius 40% of the canvas.
  const scale = rounded ? 1.32 : 0.95;
  return `  <rect width="1024" height="1024"${rounded ? ' rx="224"' : ''} fill="${surface}"/>
  <g transform="translate(512 512) scale(${String(scale)}) translate(-512 -512)">
${mark}
  </g>`;
};

const roundedArt = art(true);
const waiting = `  <circle cx="834" cy="190" r="114" fill="${ring}"/>
  <circle cx="834" cy="190" r="82" fill="${danger}"/>`;
writeFileSync(new URL('favicon.svg', PUBLIC), wrap(roundedArt));
writeFileSync(new URL('favicon-waiting.svg', PUBLIC), wrap(`${roundedArt}\n${waiting}`));

const icons = [
  { file: 'icon-192.png', size: 192, rounded: true },
  { file: 'icon-512.png', size: 512, rounded: true },
  { file: 'icon-maskable-512.png', size: 512, rounded: false },
  { file: 'apple-touch-icon.png', size: 180, rounded: false },
] as const;

const browser = await chromium.launch();
try {
  for (const icon of icons) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    const svg = wrap(icon.rounded ? roundedArt : art(false)).replace(
      '<svg ',
      `<svg width="${String(icon.size)}" height="${String(icon.size)}" `,
    );
    await page.setContent(`<style>*{margin:0}svg{display:block}</style>${svg}`);
    await page.screenshot({
      path: new URL(icon.file, PUBLIC).pathname,
      omitBackground: icon.rounded,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
