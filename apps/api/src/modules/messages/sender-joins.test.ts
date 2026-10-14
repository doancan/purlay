/**
 * A message's sender is null for an event (D-134 §6), so an inner join from a message to its sender
 * drops every event it meets — without a word, from a page, a replay or a search. A read that joins
 * the sender joins it on the left, unless it reads only messages a person wrote, and says so here.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

/** Each place that may join the sender on the inside, and why only people's messages reach it. */
const PEOPLE_ONLY: Readonly<Record<string, string>> = {
  'modules/attachments/files.ts': 'only a person’s message carries files; an event has none',
  'modules/push/sender.ts': 'a push is for a notification, and an event never notifies (D-134 §7)',
};

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [path] : [];
  });

const INNER_SENDER_JOIN = /\.innerJoin\(\s*'users[^']*',\s*'[^']+',\s*'[^']*sender_id'\s*\)/;

describe('joining a message to its sender', () => {
  test('is on the left everywhere events can be read', () => {
    const inner = sources(ROOT)
      .filter((path) => INNER_SENDER_JOIN.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(ROOT.length + 1));
    expect(inner.sort()).toEqual(Object.keys(PEOPLE_ONLY).sort());
  });

  test('the search can find one: it is not matching nothing', () => {
    expect(INNER_SENDER_JOIN.test(".innerJoin('users', 'users.id', 'messages.sender_id')")).toBe(
      true,
    );
    expect(INNER_SENDER_JOIN.test(".leftJoin('users', 'users.id', 'messages.sender_id')")).toBe(
      false,
    );
  });
});
