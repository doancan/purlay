/**
 * The kinds of notification are declared by the modules that send them (`notifications` in the manifest, D-265), and three
 * other places say the same thing: the wire's `NotificationType`, `NEEDS_YOU` (what the badge, the title and a push count),
 * and the database's `notification_type`. A kind added to one and not to the declaration, or the other way, fails here
 * instead of reaching a person as a notification no screen knows how to say.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { NEEDS_YOU, NotificationType } from '@purlay/types';
import { bundledModules, type BundledModule } from './composition';

const carried: readonly BundledModule[] = bundledModules;
const declared = carried.flatMap((module) => module.manifest.notifications ?? []);
/** Chat's kinds are the wire's `NotificationType`, `NEEDS_YOU` and the database's enum; another module's are its own (D-286). */
const chatKinds = carried
  .filter((module) => module.manifest.id === 'chat')
  .flatMap((module) => module.manifest.notifications ?? []);
const sorted = (names: Iterable<string>): string[] => [...names].sort();

/** The values of the database's enum, as the generated types name them. */
const databaseKinds = (): string[] => {
  const text = readFileSync(join(import.meta.dir, '../../../packages/db/src/schema.ts'), 'utf8');
  const line = /export type NotificationType = ([^;]+);/.exec(text)?.[1] ?? '';
  return [...line.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? '');
};

describe('the kinds of notification', () => {
  test('of chat are the wire’s and the database’s, each declared once, and no other module’s is one of them', () => {
    const wire = NotificationType.anyOf.map((type) => type.const);
    expect(sorted(chatKinds.map((kind) => kind.type))).toEqual(sorted(wire));
    expect(sorted(databaseKinds())).toEqual(sorted(wire));
    expect(new Set(declared.map((kind) => kind.type)).size).toBe(declared.length);
    const others = declared.filter((kind) => !chatKinds.includes(kind));
    expect(others.map((kind) => kind.type)).toEqual(['issue_assigned']);
    expect(others.filter((kind) => wire.some((type) => type === kind.type))).toEqual([]);
  });

  test('that need the person are `NEEDS_YOU`, in its order', () => {
    expect(chatKinds.filter((kind) => kind.needsYou).map((kind) => kind.type)).toEqual([
      ...NEEDS_YOU,
    ]);
  });

  test('that need the person are pushed, so a push never tells less than the badge counts', () => {
    expect(declared.filter((kind) => kind.needsYou && !kind.pushed)).toEqual([]);
  });

  test('that are pushed and not chat’s have words, in both languages, from the module that declares them', () => {
    for (const module of carried.filter((one) => one.manifest.id !== 'chat')) {
      for (const kind of (module.manifest.notifications ?? []).filter((one) => one.pushed)) {
        for (const locale of ['en', 'tr'] as const) {
          const saying = module.noticeWords?.(kind.type, locale, 'Ada');
          expect(saying?.body, `${kind.type} in ${locale}`).toContain('Ada');
          expect(saying?.path, kind.type).toMatch(/^[a-z][a-z-]*$/);
        }
      }
    }
  });
});
