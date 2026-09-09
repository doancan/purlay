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
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
    // The bundle budget is measured in `PRD.md` §5 terms. Reporting compressed
    // size keeps the number in the build output rather than in somebody's head.
    reportCompressedSize: true,
  },
});
