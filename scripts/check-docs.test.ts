/**
 * The document check can fail.
 *
 * For its whole life before #193 it printed what it found and exited 0, so the
 * `documents` job and `verify` reported success for every repository state. A
 * gate is only evidence once it has been seen to refuse (`CONTRIBUTING.md` §6.4),
 * so each class of defect it exists for is planted in a copy and must turn the
 * exit status red — and the untouched copy must stay green, or "red" would mean
 * nothing either.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/check-docs.py');
const copies: string[] = [];

afterAll(() => {
  for (const copy of copies) rmSync(copy, { recursive: true, force: true });
});

/**
 * Every tracked file. Not only the documents: a link may point at any file, and a
 * copy missing one would fail the check for a reason no test here is about.
 */
const aCopy = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'check-docs-'));
  copies.push(root);
  const tracked = Bun.spawnSync(['git', 'ls-files']).stdout.toString().trim().split('\n');
  for (const file of tracked) cpSync(file, join(root, file));
  return root;
};

const edit = (root: string, file: string, change: (text: string) => string): void => {
  const path = join(root, file);
  const before = readFileSync(path, 'utf8');
  const after = change(before);
  // An edit that matched nothing would make the red result below mean nothing.
  expect(after).not.toBe(before);
  writeFileSync(path, after);
};

const run = (root: string): { status: number; output: string } => {
  const result = Bun.spawnSync(['python3', SCRIPT], { cwd: root });
  return { status: result.exitCode, output: result.stdout.toString() };
};

describe('the document check', () => {
  test('passes on the repository as it is', () => {
    const { status, output } = run(aCopy());
    expect({ status, output }).toEqual({
      status: 0,
      output: expect.stringContaining('[ok]') as string,
    });
  });

  test("does not read a person's own tooling directories, which no clone has and no commit carries", () => {
    const root = aCopy();
    // What an agent's notes on one machine look like: a pinned version, a stale count, a conflict marker.
    for (const dir of ['.superpowers/sdd/plan', '.superdesign/notes', '.swarm/log']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(
        join(root, dir, 'report.md'),
        `Bun 1.4.3 was used. It claims 9 decisions.\n${'<'.repeat(7)} HEAD\n`,
      );
    }
    const { status, output } = run(root);
    expect({ status, output }).toEqual({
      status: 0,
      output: expect.stringContaining('[ok]') as string,
    });
  });

  test('fails on a citation of a decision that does not exist', () => {
    const root = aCopy();
    edit(root, 'docs/PRD.md', (text) => `${text}\nSee D-999.\n`);
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('D-999');
  });

  test('fails on a gap in decision numbering', () => {
    const root = aCopy();
    edit(root, 'docs/DECISIONS.md', (text) => text.replace(/^### D-2\. /m, '### Formerly D-2. '));
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('D-numbering has a gap');
  });

  test('fails on an unresolved merge conflict, in any tracked file', () => {
    const root = aCopy();
    // Built from pieces so this file does not itself contain what the check refuses.
    const marker = `${'<'.repeat(7)} HEAD`;
    edit(root, 'docs/CONFIG.md', (text) => `${text}\n${marker}\nours\n`);
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('unresolved merge conflict marker');
    expect(output).toContain('docs/CONFIG.md');
  });

  test('fails when decisions are out of order, which the count cannot see', () => {
    const root = aCopy();
    edit(root, 'docs/DECISIONS.md', (text) =>
      text.replace(/^## Part D/m, '### D-1. A late copy\n\n## Part D'),
    );
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('decisions are out of order');
  });

  test('fails when a migration file is missing from SCHEMA.md', () => {
    const root = aCopy();
    edit(root, 'docs/SCHEMA.md', (text) =>
      text.replace(/^0007_message_content_limit\.sql.*$/m, ''),
    );
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('0007_message_content_limit.sql');
  });
});
