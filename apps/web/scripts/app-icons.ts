/**
 * The installed application's pictures, drawn from `public/favicon.svg` (D-230): the favicon is their
 * one source, and these are what a home screen cannot take as SVG. Run `bun run icons` after the
 * favicon changes; `src/app-icons.test.ts` fails until it is run.
 *
 * - `icon-192.png`, `icon-512.png`: the favicon as it is, rounded, for launchers that draw no shape.
 * - `icon-maskable-512.png`, `apple-touch-icon.png`: the favicon without its rounding, full-bleed —
 *   the launcher or iOS cuts its own shape, and the glyph already sits inside the maskable safe zone.
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const PUBLIC = new URL('../public/', import.meta.url);
const favicon = readFileSync(new URL('favicon.svg', PUBLIC), 'utf8');
const fullBleed = favicon.replace(/ rx="[^"]*"/, '');

const ICONS = [
  { file: 'icon-192.png', size: 192, svg: favicon },
  { file: 'icon-512.png', size: 512, svg: favicon },
  { file: 'icon-maskable-512.png', size: 512, svg: fullBleed },
  { file: 'apple-touch-icon.png', size: 180, svg: fullBleed },
] as const;

const browser = await chromium.launch();
try {
  for (const icon of ICONS) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    const sized = icon.svg.replace(
      '<svg ',
      `<svg width="${String(icon.size)}" height="${String(icon.size)}" `,
    );
    await page.setContent(`<style>*{margin:0}svg{display:block}</style>${sized}`);
    await page.screenshot({ path: new URL(icon.file, PUBLIC).pathname, omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
