/**
 * A module's manifest declares the audit actions it records (`auditActions`), and the core reads that list: the trail's
 * filter, and who reads which rows. This holds the list to the code in both directions, as `module-emissions.test.ts` does
 * for events: a module that records an action its manifest does not list would have it filtered, read and hidden by
 * nobody's rules, and one that lists an action no source of its own records is promising a row that never comes.
 *
 * It scans the production source for the two shapes an action is written in — `action: '…'` in an entry and
 * `audit(context, '…', …)` where a feature builds its entries. A name built is not seen by it.
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
