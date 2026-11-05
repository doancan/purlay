/**
 * A module's manifest declares the audit actions it records and the permissions it asks (`auditActions`, `permissions`),
 * and the core reads those lists: the trail's filter, who reads which rows, who holds what. This holds each list to the
 * code in both directions, as `module-emissions.test.ts` does for events: a module that records an action its manifest
 * does not list would have it filtered, read and hidden by nobody's rules, and one that lists an action no source of its
 * own records is promising a row that never comes.
 *
 * It scans the production source for the two shapes an action is written in — `action: '…'` in an entry and
 * `audit(context, '…', …)` where a feature builds its entries — and for a permission written as a string at a call of
 * `holds(role, '…')`. A name built or held in a constant is not seen by it; the constant a manifest declares is the same one
 * the service asks, so the two cannot differ, and a constant that is declared and no longer written in the module's source
 * is what the last check finds.
 */
import { describe, expect, test } from 'bun:test';
import { AUDIT_ACTIONS } from '@purlay/types';
import { bundledModules, type BundledModule } from './composition';
import { CORE_CLAIMS } from './platform/module-kit/core-claims';
import { coreSources, shown, sourcesOf, textOf } from './testing/module-sources';

const carried: readonly BundledModule[] = bundledModules;
const CORE_ACTIONS: readonly string[] = CORE_CLAIMS.auditActions;
const IDS = carried.map((module) => module.manifest.id);

/** Each of `actions` that `text` records: `action: 'x'` but not the first of a union of types, and `audit(context, 'x'`. */
const recordedIn = (text: string, actions: readonly string[]): string[] =>
  actions.filter((action) => {
    const quoted = action.replaceAll('.', '\\.');
    return new RegExp(
      `\\baction:\\s*'${quoted}'(?!\\s*\\|)|\\baudit\\([^,()]+,\\s*'${quoted}'`,
    ).test(text);
  });

/** The permission written as a string at a call of `holds`. */
const heldIn = (text: string): string[] =>
  [...text.matchAll(/\bholds\(\s*[^,()]+,\s*'([^']+)'/g)].map((match) => match[1] ?? '');

const declaredActions = (module: BundledModule): string[] =>
  (module.manifest.auditActions ?? []).flatMap((group) => group.actions);

describe('what the sweep sees', () => {
  test('finds an action recorded in either shape, and not a type or a mention', () => {
    const names = ['issue.created', 'issue.deleted', 'issue.assigned'];
    expect(recordedIn("{ action: 'issue.created', targetType: 'issue' }", names)).toEqual([
      'issue.created',
    ]);
    expect(recordedIn("audit(context, 'issue.deleted', issueId)", names)).toEqual([
      'issue.deleted',
    ]);
    expect(
      recordedIn("action: 'issue.created' | 'issue.deleted'; // issue.assigned", names),
    ).toEqual([]);
  });

  test('finds a permission asked by name', () => {
    expect(heldIn("permissions.holds(context.role, 'issues.delete-any')")).toEqual([
      'issues.delete-any',
    ]);
    expect(heldIn('permissions.holds(context.role, ISSUES_DELETE_ANY)')).toEqual([]);
  });
});

describe('the audit actions a module records are the ones it declares', () => {
  test.each(carried.map((module) => [module.manifest.id, module] as const))(
    '%s records its own and the core’s, and every one it declares',
    (id, module) => {
      const own = declaredActions(module);
      const unlisted: string[] = [];
      for (const file of sourcesOf(id)) {
        for (const action of recordedIn(textOf([file]), AUDIT_ACTIONS)) {
          if (!own.includes(action) && !CORE_ACTIONS.includes(action)) {
            unlisted.push(`${shown(file)}: ${action}`);
          }
        }
      }
      expect(unlisted).toEqual([]);
      const written = recordedIn(textOf(sourcesOf(id)), own);
      expect(own.filter((action) => !written.includes(action))).toEqual([]);
    },
  );

  test('the core records its own and no module’s, and every one it claims', () => {
    const files = coreSources(IDS);
    const moduleActions = carried.flatMap(declaredActions);
    const foreign: string[] = [];
    for (const file of files) {
      for (const action of recordedIn(textOf([file]), moduleActions)) {
        foreign.push(`${shown(file)}: ${action}`);
      }
    }
    expect(foreign).toEqual([]);
    const written = recordedIn(textOf(files), CORE_ACTIONS);
    expect(CORE_ACTIONS.filter((action) => !written.includes(action))).toEqual([]);
  });
});

describe('the permissions a module asks are the ones it declares', () => {
  test.each(carried.map((module) => [module.manifest.id, module] as const))(
    '%s asks only what it or the core declares, and writes every name it declares',
    (id, module) => {
      const own = (module.manifest.permissions ?? []).map((declared) => declared.name);
      const allowed = [...own, ...CORE_CLAIMS.permissions];
      const asked = heldIn(textOf(sourcesOf(id)));
      expect(asked.filter((name) => !allowed.includes(name))).toEqual([]);
      const text = textOf(sourcesOf(id));
      expect(own.filter((name) => !text.includes(`'${name}'`))).toEqual([]);
    },
  );

  test('the core asks only what it declares, and none of a module’s', () => {
    const asked = heldIn(textOf(coreSources(IDS)));
    expect(asked.filter((name) => !CORE_CLAIMS.permissions.includes(name))).toEqual([]);
  });
});
