/**
 * The consent's tests are about the consent, not about its chunk arriving. The screen is a lazy chunk (`load.tsx`)
 * and the page is the loading skeleton until it comes; on a slow runner a cold `import()` took longer than the
 * four timer turns the tests allowed, and the first five tests of the file failed on the skeleton while the rest,
 * which ran after it had arrived, passed. Nothing in the process was shared: it was a race, and a fast machine
 * never loses it. So the file is run here with the chunk made late, as a slow runner makes it, and must pass.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCREEN_TESTS = 'apps/web/src/features/native/native-sign-in-screen.test.tsx';
const LATE_BY_MS = 400;

/** A preload that holds the screen's module back for `LATE_BY_MS` before it is read. */
const lateChunk = `import { plugin } from 'bun';
plugin({
  name: 'late-native-chunk',
  setup(build) {
    build.onLoad({ filter: /features\\/native\\/native-sign-in-screen\\.tsx$/ }, async (args) => {
      await Bun.sleep(${String(LATE_BY_MS)});
      return { contents: await Bun.file(args.path).text(), loader: 'tsx' };
    });
  },
});
`;

test('the consent passes when the screen’s chunk arrives late, as it does on a slow runner', () => {
  const preload = join(mkdtempSync(join(tmpdir(), 'late-chunk-')), 'late-chunk.ts');
  writeFileSync(preload, lateChunk);
  const done = spawnSync('bun', ['--no-env-file', 'test', '--preload', preload, SCREEN_TESTS], {
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const output = `${done.stdout}${done.stderr}`;
  expect(output).toMatch(/\b21 pass\b/);
  expect(output).toContain(' 0 fail');
  expect(done.status).toBe(0);
}, 70_000);
