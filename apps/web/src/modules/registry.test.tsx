/**
 * The manifests, held against the things that read them (D-250, `docs/MODULES.md` §6): a manifest that names a
 * route the router does not know, puts another module's route on the rail, or lists a place in the palette that is
 * not its own is a test failing here, whichever module wrote it. The tests are over `MODULES`, so a module added
 * to the registry is held to them without a line of its own.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { en } from '../i18n/catalogue/en';
import { matchRoute, moduleOf, spell, type RouteName } from '../router/routes';
import { sectionsFor } from '../features/settings/sections';
import { installDom } from '../testing/dom';
import { renderApp } from '../testing/render';
import { ShortcutList } from '../features/shortcuts/shortcuts-dialog';
import type { ModuleSettingsPage, ModuleShortcut } from './manifest';
import { MODULES, running } from './registry';

installDom();

/** An address for a route, every param the client has given a value. */
const addressOf = (name: string): string =>
  spell(name as RouteName, { slug: 'x', channelId: 'x', section: 'x' });

const allIds = MODULES.map((module) => module.id);

describe('every module’s routes', () => {
  test('are known to the router, mean themselves, and are the module’s', () => {
    for (const module of MODULES) {
      expect(Object.keys(module.routes).length).toBeGreaterThan(0);
      for (const name of Object.keys(module.routes)) {
        expect(matchRoute(addressOf(name)).name as string).toBe(name);
        expect(moduleOf(name as RouteName)).toBe(module.id);
      }
    }
  });

  test('are one module’s each: no two manifests declare the same name', () => {
    const names = MODULES.flatMap((module) => Object.keys(module.routes));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('every module’s rail entries', () => {
  test('are for a route the module owns or the core does, never another module’s', () => {
    for (const module of MODULES) {
      for (const entry of module.rail) {
        const route = entry.route as string;
        expect(matchRoute(addressOf(route)).name as string).toBe(route);
        expect([null, module.id as string | null]).toContain(moduleOf(route as RouteName));
      }
    }
  });
});

describe('every module’s palette places', () => {
  test('are the module’s own routes, so the module’s gate is the one that offers them', () => {
    for (const module of MODULES) {
      for (const place of module.palette) {
        expect(moduleOf(place.route as RouteName)).toBe(module.id);
      }
    }
  });
});

describe('where a module’s pages and keys sit', () => {
  test('a settings page is after the page its manifest names, and the page exists', () => {
    const ids = sectionsFor('owner', true, allIds).map((section) => section.id as string);
    for (const module of MODULES) {
      for (const page of module.settings as readonly ModuleSettingsPage[]) {
        expect(ids).toContain(page.id);
        if (page.after === undefined) continue;
        expect(ids).toContain(page.after);
        expect(ids.indexOf(page.id)).toBeGreaterThan(ids.indexOf(page.after));
      }
    }
  });

  test('a shortcut row is after the row its manifest names, in the group it names', async () => {
    const view = await renderApp(<ShortcutList mac={false} modules={allIds} />);
    const groups = [...view.container.querySelectorAll('section')].map((section) => ({
      title: section.querySelector('h3')?.textContent,
      rows: [...section.querySelectorAll('li')].map((row) => row.firstElementChild?.textContent),
    }));
    for (const module of MODULES) {
      for (const row of module.shortcuts as readonly ModuleShortcut[]) {
        const group = groups.find((candidate) => candidate.title === en[row.group]);
        expect(group).toBeDefined();
        const at = group?.rows.indexOf(en[row.label]) ?? -1;
        expect(at).toBeGreaterThanOrEqual(0);
        if (row.after !== undefined) {
          expect(at).toBeGreaterThan(group?.rows.indexOf(en[row.after]) ?? Infinity);
        }
      }
    }
    // The core's own rows stay where they were, and chat's sit among them as its manifest says.
    expect(groups[0]?.rows.slice(0, 5)).toEqual([
      en['shortcuts.palette'],
      en['shortcuts.reference'],
      en['shortcuts.settings'],
      en['shortcuts.close'],
      en['shortcuts.channels'],
    ]);
  });
});

describe('the registry', () => {
  test('lists every module that has a manifest, so a manifest left out of it is a failing test', () => {
    const features = join(import.meta.dirname, '..', 'features');
    const withManifest = readdirSync(features).filter((folder) =>
      existsSync(join(features, folder, 'manifest.ts')),
    );
    expect(withManifest.sort()).toEqual([...allIds].sort());
  });
});

describe('the modules a server runs', () => {
  test('are the registry’s that its list names, in the registry’s order', () => {
    expect(running([]).map((module) => module.id)).toEqual([]);
    expect(running(['issues', 'chat', 'unknown']).map((module) => module.id)).toEqual([
      'chat',
      'issues',
    ]);
  });
});
