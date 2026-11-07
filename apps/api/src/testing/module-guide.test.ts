/**
 * `docs/MODULE-GUIDE.md` names files and commands; each exists (`CONTRIBUTING.md` §6.1: a second copy is bound by a test).
 * Paths are checked where they start at the repository's root; a path with a placeholder for the module's id is an example.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '../../../..');
const guide = readFileSync(join(ROOT, 'docs/MODULE-GUIDE.md'), 'utf8');
const quoted = [...guide.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '');

describe('the module guide', () => {
  test('names only paths that exist', () => {
    const paths = quoted.filter(
      (token) =>
        /^(apps|packages|scripts|docs|\.github)\//.test(token) &&
        !/[<>*]|notes|zz/.test(token) &&
        !token.includes(' '),
    );
    expect(paths.length).toBeGreaterThan(5);
    expect(paths.filter((path) => !existsSync(join(ROOT, path)))).toEqual([]);
  });

  test('names only commands the root package has', () => {
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const commands = [...guide.matchAll(/bun run ([a-z:-]+)/g)].map((match) => match[1] ?? '');
    expect(commands).toContain('module:new');
    expect(commands.filter((command) => !(command in scripts))).toEqual([]);
  });

  test('is the length of a guide, and is listed among the documents', () => {
    expect(guide.split('\n').length).toBeLessThanOrEqual(250);
    expect(readFileSync(join(ROOT, 'docs/OVERVIEW.md'), 'utf8')).toContain('MODULE-GUIDE.md');
  });
});
