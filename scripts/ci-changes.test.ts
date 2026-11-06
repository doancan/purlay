/** Which changes spend the browser jobs. */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, needsBrowser, needsModules, needsMutations, run } from './ci-changes';

describe('the browser jobs', () => {
  test('always run on main', () => {
    expect(needsBrowser('push', [])).toBe(true);
  });

  test.each([
    'apps/web/src/features/shell/rail.tsx',
    'apps/api/src/realtime/hub.ts',
    'packages/types/src/api.ts',
    'package.json',
    'bun.lock',
    '.github/workflows/ci.yml',
  ])('run for a pull request that changes %s', (file) => {
    expect(needsBrowser('pull_request', ['docs/UX.md', file])).toBe(true);
  });

  test('do not run for documents, scripts or another workflow alone', () => {
    expect(
      needsBrowser('pull_request', [
        'docs/DECISIONS.md',
        'CONTRIBUTING.md',
        'scripts/check-docs.py',
        '.github/workflows/codeql.yml',
      ]),
    ).toBe(false);
  });
});

describe('the modules job', () => {
  test('always runs on main', () => {
    expect(needsModules('push', [])).toBe(true);
  });

  test.each([
    'apps/api/src/composition.ts',
    'apps/api/src/testing/module-smoke.ts',
    'packages/db/src/cli/migrate.ts',
    'package.json',
    'bun.lock',
    '.github/workflows/ci.yml',
  ])('runs for a pull request that changes %s', (file) => {
    expect(needsModules('pull_request', ['docs/UX.md', file])).toBe(true);
  });

  test('does not run for the client, documents or another workflow, which cannot move an answer', () => {
    expect(
      needsModules('pull_request', [
        'apps/web/src/features/shell/rail.tsx',
        'docs/MODULES.md',
        'scripts/check-docs.py',
        '.github/workflows/codeql.yml',
      ]),
    ).toBe(false);
  });
});

describe('the mutations job', () => {
  test('always runs on main', () => {
    expect(needsMutations('push', [])).toBe(true);
  });

  test.each([
    'scripts/mutations/api-issues.ts',
    'scripts/mutations/index.ts',
    'scripts/mutate.ts',
    'scripts/run-mutations.ts',
    'scripts/mutation-selection.ts',
    '.github/workflows/ci.yml',
  ])('runs for a pull request that changes %s', (file) => {
    expect(needsMutations('pull_request', ['docs/UX.md', file])).toBe(true);
  });

  test('does not run for code a mutation names, documents or another workflow', () => {
    expect(
      needsMutations('pull_request', [
        'apps/api/src/features/issues/service.ts',
        'scripts/mutations.test.ts',
        'docs/MODULES.md',
        '.github/workflows/mutations.yml',
      ]),
    ).toBe(false);
  });
});

describe('the command', () => {
  const listing =
    (files: string[], exitCode = 0) =>
    (command: readonly string[]): { exitCode: number; stdout: string; stderr: string } => {
      expect(command.slice(0, 3)).toEqual(['gh', 'api', 'repos/o/r/pulls/7/files']);
      return { exitCode, stdout: files.join('\n'), stderr: exitCode === 0 ? '' : 'not found' };
    };

  test("writes the answer to CI's output", () => {
    const output = join(mkdtempSync(join(tmpdir(), 'purlay-ci-changes-')), 'out');
    const environment = {
      EVENT: 'pull_request',
      REPOSITORY: 'o/r',
      NUMBER: '7',
      GITHUB_OUTPUT: output,
    };
    expect(main(environment, listing(['docs/UX.md']))).toBe(
      'browser=false\nmodules=false\nmutations=false',
    );
    expect(readFileSync(output, 'utf8')).toBe('browser=false\nmodules=false\nmutations=false\n');
  });

  test('asks nothing of GitHub on main', () => {
    expect(
      main({ EVENT: 'push' }, () => {
        throw new Error('not asked');
      }),
    ).toBe('browser=true\nmodules=true\nmutations=true');
  });

  test('says each job on its own: a client change is a browser run and no modules run', () => {
    expect(
      main(
        { EVENT: 'pull_request', REPOSITORY: 'o/r', NUMBER: '7' },
        listing(['apps/web/src/main.tsx']),
      ),
    ).toBe('browser=true\nmodules=false\nmutations=false');
  });

  test('refuses rather than guessing when the files cannot be read', () => {
    expect(() =>
      main({ EVENT: 'pull_request', REPOSITORY: 'o/r', NUMBER: '7' }, listing([], 1)),
    ).toThrow('could not be read: not found');
  });
});

test('a command is run as given, its output and failure kept', () => {
  expect(run(['echo', 'listed'])).toEqual({ exitCode: 0, stdout: 'listed\n', stderr: '' });
  expect(run(['false']).exitCode).not.toBe(0);
});
