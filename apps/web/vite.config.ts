/**
 * The client build.
 *
 * Tailwind arrives through its Vite plugin and one line of CSS — no
 * `tailwind.config.js`, no PostCSS config, no `content` array. That is not a
 * simplification, it is what version 4 wants; source detection was confirmed to
 * find every utility, including the awkward ones (`docs/spikes/web-client.md`).
 *
 * This file lives at the package root, outside `src`, so it belongs to
 * `tsconfig.tooling.json` rather than to the app's project — build-tool files
 * that belong to no project are lint parse errors, and the check added in #158
 * fails on exactly that.
 */
import packageJson from './package.json' with { type: 'json' };
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** `browserslist`'s `name >= version` entries, as esbuild names its targets (`safari17.2`). */
const buildTarget = (queries: readonly string[]): string[] =>
  queries.map((query) => {
    const match = /^(chrome|edge|firefox|safari|ios_saf) >= ([0-9.]+)$/.exec(query);
    if (match === null) throw new Error(`browserslist entry the build cannot read: ${query}`);
    const [, name = '', version = ''] = match;
    return `${name === 'ios_saf' ? 'ios' : name}${version}`;
  });

const { browserslist } = packageJson;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Overridable for the same reason the compose ports are: a busy port is the
    // friction that turns "runs from the README" into a support ticket.
    port: Number(process.env['WEB_PORT'] ?? 5173),

    // The browser talks to one origin, in development as in production (D-61).
    // Cookies, redirect URIs and the socket's `Origin` are exactly what cannot be
    // tested on a machine whose topology differs from the deployed one.
    //
    // Every path the API owns is listed. Leaving one out recreates the difference
    // this exists to remove, one path at a time — `/health` was missing and
    // answered with the client's HTML.
    proxy: Object.fromEntries(
      ['/auth', '/api', '/ws', '/health'].map((prefix) => [
        prefix,
        {
          target: `http://localhost:${String(process.env['PORT'] ?? 3001)}`,
          changeOrigin: false,
          ws: prefix === '/ws',
        },
      ]),
    ),
  },
  build: {
    // The supported browsers (D-113), derived from `browserslist` rather than kept twice: syntax
    // they lack is lowered for them, or the build fails.
    target: buildTarget(browserslist),
    // The bundle budget is measured in `PRD.md` §5 terms. Reporting compressed
    // size keeps the number in the build output rather than in somebody's head.
    reportCompressedSize: true,
    // Kept only when asked for: `bun run budget:web` uses a source map to name what grew
    // inside the largest chunk, and a map served to everyone is not something to ship.
    sourcemap: process.env['PURLAY_SOURCEMAP'] === '1' ? 'hidden' : false,
    rollupOptions: {
      // The push worker is an entry of its own, at the root and under a name that never changes:
      // a worker's scope is where it is served from, and a browser finds it again by its address
      // (D-126). It imports nothing the page does, so it is one file — a worker that is a classic
      // script cannot load a chunk. `e2e/push-worker.e2e.ts` checks what the build serves.
      input: { index: 'index.html', 'push-worker': 'worker/push-worker.ts' },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'push-worker' ? 'push-worker.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
