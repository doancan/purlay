/**
 * A module's manifest lists the socket operations it owns and the server events its services send (`frames`, `events`),
 * and a process that does not run the module closes both. An event the module sends and does not list would reach a
 * process that does not run it (`MODULES.md` §2).
 *
 * `core-claims.test.ts` holds the lists to the schema: a name in `ClientFrame` or `ServerFrame` is the core's or exactly one
 * module's. That cannot see a module whose code names an event or an operation the *other* owner lists, which is the
 * mistake of a module that sends an event it forgot to claim while the schema still has an owner for it. This reads each
 * module's own source — its folder under `features/` and its route file `ingress/http/<id>.ts` — and holds every event or
 * operation it names to the module's list or the core's.
 *
 * It is a scan for the name as a string literal, so it sees a module that writes the name and not one that builds it. The
 * events chat's services publish through the core's builders in `platform/events.ts` are named there, in the core's file,
 * so they are held by the schema test alone.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ClientFrame, ServerFrame } from '@purlay/types';
import { bundledModules, type BundledModule } from './composition';
import { CORE_EVENTS, CORE_FRAMES } from './platform/module-kit/core-claims';

const SOURCE = /\.tsx?$/;
const NOT_PRODUCTION = /\.(test|integration\.test)\.tsx?$|[\\/]testing[\\/]/;

const filesUnder = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

/** Each of `names` that `text` writes as a string literal, in either quote. */
const namedIn = (text: string, names: readonly string[]): string[] =>
  names.filter((name) => new RegExp(`['"\`]${name}['"\`]`).test(text));

/** The files that are the module's: its folder and, when there is one, its route file. */
const sourcesOf = (id: string): string[] => {
  const route = join(import.meta.dir, 'ingress/http', `${id}.ts`);
  return [
    ...filesUnder(join(import.meta.dir, 'features', id)),
    ...(existsSync(route) ? [route] : []),
  ].filter((file) => SOURCE.test(file) && !NOT_PRODUCTION.test(file));
};

const carried: readonly BundledModule[] = bundledModules;
const EVENTS = ServerFrame.anyOf.map((frame) => frame.properties.event.const as string);
const OPERATIONS = ClientFrame.anyOf.map((frame) => frame.properties.op.const as string);

describe('what a module’s code names on the socket', () => {
  test('finds a name written as a string literal, and only that', () => {
    const names = ['MESSAGE_CREATED', 'TYPING'];
    expect(namedIn("bus.publish(t, { event: 'MESSAGE_CREATED' })", names)).toEqual([
      'MESSAGE_CREATED',
    ]);
    expect(namedIn('{ event: "TYPING" }', names)).toEqual(['TYPING']);
    expect(namedIn('const TYPING_TTL_MS = 6_000; // MESSAGE_CREATED', names)).toEqual([]);
  });

  test.each(carried.map((module) => [module.manifest.id, module] as const))(
    'every event and operation %s names is its own or the core’s',
    (id, module) => {
      const ownEvents = new Set([...(module.manifest.events ?? []), ...CORE_EVENTS]);
      const ownOperations = new Set([...(module.manifest.frames ?? []), ...CORE_FRAMES]);
      const unlisted: string[] = [];
      for (const file of sourcesOf(id)) {
        const text = readFileSync(file, 'utf8');
        for (const event of namedIn(text, EVENTS)) {
          if (!ownEvents.has(event)) unlisted.push(`${file}: event ${event}`);
        }
        for (const op of namedIn(text, OPERATIONS)) {
          if (!ownOperations.has(op)) unlisted.push(`${file}: operation ${op}`);
        }
      }
      expect(unlisted.map((line) => line.replace(`${import.meta.dir}/`, ''))).toEqual([]);
    },
  );
});
