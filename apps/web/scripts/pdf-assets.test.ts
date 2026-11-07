import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { build, createServer, loadConfigFromFile } from 'vite';
import pdfjs from 'pdfjs-dist/package.json' with { type: 'json' };
import { pdfAssets } from './pdf-assets';
import clientConfig from '../vite.config';

test('the default bundled Vite loader can resolve the installed renderer assets', async () => {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  );
  expect(loaded).not.toBeNull();
});

test('loading the production configuration preserves the setup API and page routing in development', async () => {
  const setup = clientConfig.server?.proxy?.['/setup'];
  if (setup === undefined || typeof setup === 'string' || setup.bypass === undefined)
    throw new Error('the actual configuration lost its setup proxy');
  for (const [method, url, expected] of [
    ['GET', '/setup/status', undefined],
    ['GET', '/setup/state', undefined],
    ['GET', '/setup/resume', '/setup/resume'],
    ['POST', '/setup/state', undefined],
    ['GET', undefined, undefined],
  ] as const) {
    const socket = new Socket();
    const request = new IncomingMessage(socket);
    request.method = method;
    request.url = url;
    try {
      expect(await setup.bypass(request, new ServerResponse(request), setup)).toBe(expected);
    } finally {
      socket.destroy();
    }
  }
});

test('the production build emits versioned fonts, CMaps and JS decoders, without a script runner or WASM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'purlay-pdf-assets-'));
  try {
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><title>Asset test</title><script type="module" src="/entry.ts"></script>',
    );
    writeFileSync(
      join(root, 'entry.ts'),
      "new Worker(new URL('./probe.ts', import.meta.url), { type: 'module' });",
    );
    writeFileSync(join(root, 'probe.ts'), "postMessage('ready');");
    const result = await build({
      ...clientConfig,
      root,
      configFile: false,
      logLevel: 'silent',
      build: {
        ...clientConfig.build,
        write: false,
        rolldownOptions: {
          ...clientConfig.build?.rolldownOptions,
          input: join(root, 'index.html'),
        },
      },
    });
    const results = Array.isArray(result) ? result : [result];
    const files = results.flatMap((bundle) => {
      if (!('output' in bundle)) throw new Error('expected completed production output');
      return bundle.output.map((file) => file.fileName);
    });
    const base = `assets/pdfjs-${pdfjs.version}/`;
    expect(files).toContain(`${base}cmaps/Adobe-Japan1-0.bcmap`);
    expect(files).toContain(`${base}standard_fonts/LiberationSans-Regular.ttf`);
    expect(files).toContain(`${base}wasm/openjpeg_nowasm_fallback.js`);
    expect(files).toContain(`${base}wasm/jbig2_nowasm_fallback.js`);
    expect(
      files.some(
        (name) => name.endsWith('.wasm') || name.includes('quickjs') || name.includes('sandbox'),
      ),
    ).toBe(false);
    expect(files.some((name) => name.includes('LICENSE'))).toBe(true);
    // The router identifies trusted worker responses by this build suffix, before applying CSP.
    expect(files.some((name) => /^assets\/probe-[\w-]+\.worker\.js$/.test(name))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('development serves only its declared assets, with executable JS MIME and no path traversal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'purlay-pdf-assets-dev-'));
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [pdfAssets()],
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (address === null || address === undefined || typeof address === 'string')
      throw new Error('missing actual server address');
    const base = `http://127.0.0.1:${String(address.port)}/assets/pdfjs-${pdfjs.version}/`;
    const decoder = await fetch(`${base}wasm/openjpeg_nowasm_fallback.js`);
    expect(decoder.status).toBe(200);
    expect(decoder.headers.get('content-type')).toBe('text/javascript');
    expect(decoder.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await decoder.text()).length).toBeGreaterThan(1000);
    const font = await fetch(`${base}standard_fonts/LiberationSans-Regular.ttf`);
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('application/octet-stream');
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    for (const path of [
      'wasm/quickjs-eval.js',
      'wasm/openjpeg.wasm',
      'package.json',
      '%2e%2e/package.json',
    ]) {
      const refused = await fetch(base + path);
      expect(refused.status).toBe(404);
      await refused.arrayBuffer();
    }
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
