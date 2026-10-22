/**
 * I-9: the audit trail is append-only. Nothing in the production source updates or deletes a row of
 * it (and of the server's own, `server_audit_log`); the application inserts and reads. Held by this
 * sweep, not by a grant or a trigger (D-26; `audit_log` has none either) — and the sweep
 * proves it is looking at code by finding the one insert that must be there.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');

const sources = (dir: string): { path: string; text: string }[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.includes('.test.'),
    )
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path, text: readFileSync(path, 'utf8') };
    });

describe('the audit trail is append-only (I-9)', () => {
  const all = [...sources('apps/api/src'), ...sources('packages/db/src')];

  test('the sweep sees the insert that writes it, so it is not looking at nothing', () => {
    expect(all.some(({ text }) => /\.insertInto\(\s*'audit_log'\s*\)/.test(text))).toBe(true);
    // The server's own trail is held on the same terms (`SCHEMA.md` §9.1a).
    expect(all.some(({ text }) => /\.insertInto\(\s*'server_audit_log'\s*\)/.test(text))).toBe(
      true,
    );
  });

  test('no production source updates or deletes a row of it', () => {
    const offending = all
      .filter(({ text }) =>
        /\.(updateTable|deleteFrom)\(\s*'(server_)?audit_log'\s*\)|\b(update|delete\s+from)\s+(server_)?audit_log\b/i.test(
          text,
        ),
      )
      .map(({ path }) => path);
    expect(offending).toEqual([]);
  });
});
