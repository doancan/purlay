/**
 * The web application's pictures, all drawn from the owner's mark (`public/purlay-mark.svg`, D-339):
 * the tab icon, its waiting variant (D-148) and the installed application's pictures (D-230), which
 * a home screen cannot take as SVG. Run `bun run icons` after the mark or `scripts/app-icon-art.ts`
 * changes; `src/favicon.test.ts` and `src/app-icons.test.ts` fail until it is run.
 *
 * - `favicon.svg`, `favicon-waiting.svg`: the mark on its tile, and with the dot over it.
 * - `icon-192.png`, `icon-512.png`: the favicon as it is, rounded, for launchers that draw no shape.
 * - `icon-maskable-512.png`, `apple-touch-icon.png`: the favicon without its rounding, full-bleed and
 *   opaque — the launcher or iOS cuts its own shape, and the mark lies inside the maskable safe zone.
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { favicon, fullBleed, readMark, waitingFavicon } from './app-icon-art';

const PUBLIC = new URL('../public/', import.meta.url);
const brand = readFileSync(new URL('../public/purlay-mark.svg', import.meta.url), 'utf8');
const mark = readMark(brand);

const tab = favicon(mark);
writeFileSync(new URL('favicon.svg', PUBLIC), tab);
writeFileSync(new URL('favicon-waiting.svg', PUBLIC), waitingFavicon(mark));

const ICONS = [
  { file: 'icon-192.png', size: 192, svg: tab },
  { file: 'icon-512.png', size: 512, svg: tab },
  { file: 'icon-maskable-512.png', size: 512, svg: fullBleed(tab) },
  { file: 'apple-touch-icon.png', size: 180, svg: fullBleed(tab) },
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
