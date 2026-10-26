/**
 * The numbers a realtime client has to know are defined once, in `@purlay/types` (`realtime.ts`), and read
 * from there by the browser's client and by the bundle the macOS application is generated from
 * (`CONTRIBUTING.md` §6.1, D-186). A client that declared one of its own would be a second home for a fact,
 * which is the first thing the repository forbids.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACK_DEADLINE_MS,
  BACKOFF,
  CHECK_SESSION_AFTER_FAILURES,
  OUTBOX_MAX_CHARS,
  OUTBOX_MAX_MESSAGES,
  PING_AFTER_IDLE_MS,
  PONG_DEADLINE_MS,
  REPLAY_RETRY_DELAYS_MS,
  STABLE_AFTER_MS,
  TOO_BUSY_BACKOFF_STEP,
} from './realtime';

/** `packages/types/src/realtime.ts`'s exports, listed: a scan over every export of the package would flag names that merely collide. */
const contract = {
  ACK_DEADLINE_MS,
  BACKOFF,
  CHECK_SESSION_AFTER_FAILURES,
  OUTBOX_MAX_CHARS,
  OUTBOX_MAX_MESSAGES,
  PING_AFTER_IDLE_MS,
  PONG_DEADLINE_MS,
  REPLAY_RETRY_DELAYS_MS,
  STABLE_AFTER_MS,
  TOO_BUSY_BACKOFF_STEP,
};

const walk = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : walk(path);
    return /\.(ts|tsx)$/.test(path) ? [path] : [];
  });

describe('the realtime constants have one home', () => {
  const names = Object.keys(contract);

  test('the contract exports some, so this is not a scan for nothing', () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  test('no client file declares one of them again', () => {
    const files = [...walk('apps/web/src'), ...walk('apps/api/src')].filter(
      (file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'),
    );
    expect(files.length).toBeGreaterThan(100);
    const declared: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const name of names) {
        if (new RegExp(`\\b(?:export\\s+)?const\\s+${name}\\b`).test(text)) {
          declared.push(`${file}: ${name}`);
        }
      }
    }
    expect(declared).toEqual([]);
  });

  test('the scan sees a declaration when there is one', () => {
    const source = 'export const ACK_DEADLINE_MS = 3_000;\n';
    expect(new RegExp(`\\b(?:export\\s+)?const\\s+ACK_DEADLINE_MS\\b`).test(source)).toBe(true);
  });
});
