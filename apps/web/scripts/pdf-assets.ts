/** Only the pinned reader's data/JS fallbacks, under a versioned same-origin path; never its sandbox. */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';
import pdfjs from 'pdfjs-dist/package.json' with { type: 'json' };

export const pdfAssets = (): Plugin => {
  // Vite bundles its configuration before loading it. Node's resolver works in that bundled
  // module too; import.meta.resolve is rewritten to a Vite-only virtual import Bun cannot load.
  const root = new URL(
    './',
    pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
  );
  const assets = ['cmaps', 'standard_fonts', 'wasm'].flatMap((directory) => {
    const path = new URL(`${directory}/`, root);
    return readdirSync(path)
      .filter(
        (name) =>
          name.startsWith('LICENSE') ||
          (directory === 'cmaps' && name.endsWith('.bcmap')) ||
          (directory === 'standard_fonts' && /\.(pfb|ttf)$/.test(name)) ||
          (directory === 'wasm' &&
            ['openjpeg_nowasm_fallback.js', 'jbig2_nowasm_fallback.js'].includes(name)),
      )
      .map((name) => ({
        fileName: `assets/pdfjs-${pdfjs.version}/${directory}/${name}`,
        source: fileURLToPath(new URL(name, path)),
      }));
  });
  return {
    name: 'purlay-pdf-assets',
    generateBundle(): void {
      for (const asset of assets) {
        this.emitFile({
          type: 'asset',
          fileName: asset.fileName,
          source: readFileSync(asset.source),
        });
      }
    },
    configureServer(server): void {
      server.middlewares.use((request, response, next): void => {
        const path = request.url?.split('?')[0];
        const asset = assets.find((candidate) => `/${candidate.fileName}` === path);
        if (asset === undefined) {
          next();
          return;
        }
        response.setHeader(
          'Content-Type',
          asset.fileName.endsWith('.js') ? 'text/javascript' : 'application/octet-stream',
        );
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.end(readFileSync(asset.source));
      });
    },
  };
};
