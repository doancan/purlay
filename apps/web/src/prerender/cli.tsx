/**
 * Renders the shell into the built `dist/index.html`. Run by `build` after Vite.
 *
 *   bun run src/prerender/cli.tsx [dist]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inject, renderShell } from './shell';

const dist = process.argv[2] ?? 'dist';
const file = join(dist, 'index.html');
const markup = renderShell();
writeFileSync(file, inject(readFileSync(file, 'utf8'), markup));
process.stdout.write(
  `prerendered the shell into ${file} (${String(markup.length)} bytes of markup)\n`,
);
