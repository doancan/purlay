/**
 * The command line, run for real against a copy it may damage.
 *
 * `tokens:check` is a gate in `verify` and in CI, so it is shown to open and to
 * close: a clean copy passes, a hand-edited generated file fails, an unsound
 * source fails, an unreadable colour fails — and `generate` repairs what `check`
 * found. A gate that has only ever said yes is not known to say no.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('./cli.ts', import.meta.url).pathname;
const real = new URL('../', import.meta.url).pathname;
const copies: string[] = [];
afterAll(() => {
  for (const copy of copies) rmSync(copy, { recursive: true, force: true });
});

const aCopy = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'tokens-cli-'));
  copies.push(root);
  cpSync(join(real, 'tokens.json'), join(root, 'tokens.json'));
  cpSync(join(real, 'src/generated'), join(root, 'src/generated'), { recursive: true });
  return root;
};

const run = (root: string, ...flags: string[]): { status: number; out: string } => {
  const result = Bun.spawnSync(['bun', '--no-env-file', 'run', cli, '--root', root, ...flags], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { status: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
};

describe('tokens:check', () => {
  test('passes on the repository as it is', () => {
    const { status, out } = run(real, '--check');
    expect({ status, out }).toEqual({ status: 0, out: expect.stringContaining('match') as string });
  });

  test('fails when a generated file was edited by hand, and says which', () => {
    const root = aCopy();
    const file = join(root, 'src/generated/tokens.css');
    writeFileSync(file, `${readFileSync(file, 'utf8')}/* hand edit */\n`);
    const { status, out } = run(root, '--check');
    expect(status).toBe(1);
    expect(out).toContain('tokens.css');
  });

  test('fails when a generated file is missing', () => {
    const root = aCopy();
    rmSync(join(root, 'src/generated/names.ts'));
    const { status, out } = run(root, '--check');
    expect(status).toBe(1);
    expect(out).toContain('names.ts');
  });

  test('fails on an unsound source, listing the problem', () => {
    const root = aCopy();
    const file = join(root, 'tokens.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"value": "4px"', '"value": "5px"'));
    const { status, out } = run(root, '--check');
    expect(status).toBe(1);
    expect(out).toContain('not a sound token file');
    expect(out).toContain('off the 4px grid');
  });

  test('fails on a source that is sound but not readable', () => {
    const root = aCopy();
    const file = join(root, 'tokens.json');
    // Dark ink-muted becomes nearly the surface's own colour.
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('"dark": "#b4b4bb"', '"dark": "#1e2227"'),
    );
    const { status, out } = run(root, '--check');
    expect(status).toBe(1);
    expect(out).toContain('not usable');
    expect(out).toContain('ink-muted on surface-100 (dark)');
  });
});

describe('tokens:generate', () => {
  test('repairs what check found, and then check passes', () => {
    const root = aCopy();
    const file = join(root, 'src/generated/theme.css');
    writeFileSync(file, 'stale');
    expect(run(root, '--check').status).toBe(1);
    const generated = run(root);
    expect(generated.status).toBe(0);
    expect(generated.out).toContain('wrote theme.css');
    expect(run(root, '--check').status).toBe(0);
    expect(run(root).out).toContain('nothing to write');
  });
});
