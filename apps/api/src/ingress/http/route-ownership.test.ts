/**
 * Every route the application registers belongs to the core or to a module, and says which (D-250, `MODULES.md` §3).
 *
 * A module that is not run has no route: its paths are the `404` of any unknown one. That holds only for the paths its
 * manifest lists, so a route added to `app.ts` that nobody classified would stay mounted with the module off. This reads the
 * paths `app.ts` registers, and those of each module's own folder (`features/<id>/http/`, D-280), and holds each to exactly
 * one owner: the core's list below or a manifest's templates. A new route fails here until it is put in one.
 *
 * A module's HTTP is part of the module: its slot supplies `routes`, every path it registers is its manifest's and none of
 * them is also registered in `app.ts`; a module whose handlers are still partly in `ingress/http/` is listed in
 * `HTTP_IN_INGRESS`, which only shrinks, and is on it only while `app.ts` still registers one of its paths.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundledModules, type BundledModule } from '../../composition';
import { httpFolderFiles } from '../../testing/route-sources';
import type { ModuleRouteDependencies } from './module-routes';
import { CORE_ROUTES } from '../../platform/module-kit/core-claims';
import { ownsPath } from '../../platform/module-kit/routes';

/**
 * The modules whose handlers are still partly in `ingress/http/`, where `app.ts` registers some of their routes. **Only
 * shrinks**: a module listed that has none left there fails, and so does an unlisted one that has any.
 */
const HTTP_IN_INGRESS: readonly string[] = ['chat'];

const pathsIn = (text: string): string[] =>
  [...text.matchAll(/\.(?:get|post|put|patch|delete|ws)\(\s*'(\/[^']*)'/g)].map((m) => m[1] ?? '');

/** The paths `app.ts` registers itself. */
const registeredByApp = (): string[] =>
  [...new Set(pathsIn(readFileSync(join(import.meta.dir, 'app.ts'), 'utf8')))].sort();

/** The paths registered in a module's own HTTP folder, where it has one. */
const registeredByFolder = (id: string): string[] =>
  httpFolderFiles(id).flatMap((file) => pathsIn(readFileSync(file, 'utf8')));

const registered = (): string[] =>
  [
    ...new Set([
      ...registeredByApp(),
      ...bundledModules.flatMap((module) => registeredByFolder(module.manifest.id)),
    ]),
  ].sort();

/** The dependencies of a plugin that is made and never asked: a factory only registers, and reads none of it until a request. */
const unread = {} as ModuleRouteDependencies;

/** What a plugin registers, read from the plugin and not the text: handlers are not run, so the context is not read. */
const pluginPaths = (module: BundledModule): string[] =>
  module.routes === undefined ? [] : module.routes(unread).routes.map((route) => route.path);

const carried: readonly BundledModule[] = bundledModules;

describe('who owns each route', () => {
  const owners = carried.map((module) => ({
    id: module.manifest.id,
    owns: ownsPath(module.manifest.routes ?? []),
  }));

  test('every route the application registers is the core’s or exactly one module’s', () => {
    const unowned: string[] = [];
    const twice: string[] = [];
    for (const path of registered()) {
      const by = [
        ...(CORE_ROUTES.includes(path) ? ['core'] : []),
        ...owners.filter((owner) => owner.owns(path)).map((owner) => owner.id),
      ];
      if (by.length === 0) unowned.push(path);
      if (by.length > 1) twice.push(`${path}: ${by.join(', ')}`);
    }
    expect({ unowned, twice }).toEqual({ unowned: [], twice: [] });
  });

  test('the core’s list holds no route that is gone, and no module’s template matches nothing', () => {
    const paths = registered();
    expect(CORE_ROUTES.filter((path) => !paths.includes(path))).toEqual([]);
    for (const module of carried) {
      const dead = (module.manifest.routes ?? []).filter((template) => {
        const owns = ownsPath([template]);
        return !paths.some((path) => owns(path));
      });
      expect({ module: module.manifest.id, dead }).toEqual({
        module: module.manifest.id,
        dead: [],
      });
    }
  });

  test('a module’s routes come from its folder: its slot supplies them, and app.ts registers none of its paths but while it is listed', () => {
    const fromApp = registeredByApp();
    for (const module of carried) {
      const id = module.manifest.id;
      const owns = ownsPath(module.manifest.routes ?? []);
      const inApp = fromApp.filter(owns);
      expect({ id, supplies: module.routes !== undefined }).toEqual({ id, supplies: true });
      // A module whose handlers are still partly in `ingress/` is listed, and is listed only while some are.
      if (HTTP_IN_INGRESS.includes(id)) {
        expect({ id, stillInApp: inApp.length > 0 }).toEqual({ id, stillInApp: true });
      } else {
        expect({ id, inApp }).toEqual({ id, inApp: [] });
      }
      // What the plugin registers is what its folder spells, all of it the module's, and none of it twice.
      const registers = pluginPaths(module);
      expect({ id, outside: registers.filter((path) => !owns(path)) }).toEqual({ id, outside: [] });
      expect({ id, twice: registers.filter((path) => inApp.includes(path)) }).toEqual({
        id,
        twice: [],
      });
      expect([...new Set(registers)].sort()).toEqual([...new Set(registeredByFolder(id))].sort());
    }
  });

  test('the list of modules whose handlers are in ingress names only modules the build carries', () => {
    const ids = carried.map((module) => module.manifest.id);
    expect(HTTP_IN_INGRESS.filter((id) => !ids.includes(id))).toEqual([]);
  });
});
