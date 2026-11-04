/**
 * The check that every table of the schema is decided (`export-catalogue.ts`) is only as sharp as the types of the
 * contributions it sums. These are type-level: a line that stops compiling is the failure, and `tsc` over the tests
 * is what runs them.
 */
import { describe, expect, test } from 'bun:test';
import {
  EXPORT_SHARP,
  PERSONAL_EXPORT_SHARP,
  type ExcludedBy,
  type VagueContribution,
  type WrittenBy,
} from './export-catalogue';
import type { bundledModules } from './composition';
import type { ExportContribution } from './modules/export/catalogue';
import type { PersonalContribution } from './modules/export/personal-catalogue';

type Bundled = (typeof bundledModules)[number];

/** True only when the two types are the same. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

interface Named {
  readonly manifest: { readonly id: 'named' };
  readonly export: {
    readonly tables: readonly [{ readonly name: 'issues' }];
    readonly excluded: { readonly sessions: string };
  };
}
interface Annotated {
  readonly manifest: { readonly id: 'annotated' };
  readonly export: ExportContribution;
  readonly personalExport: PersonalContribution;
}
interface Empty {
  readonly manifest: { readonly id: 'empty' };
  readonly export: {
    readonly tables: readonly [];
    readonly excluded: { readonly sessions: string };
  };
}

describe('the contributions the export check sums', () => {
  test('are named table by table in every bundled module', () => {
    const sharp: Same<VagueContribution<'export' | 'personalExport', Bundled>, never> = true;
    expect(sharp).toBe(true);
    expect([EXPORT_SHARP, PERSONAL_EXPORT_SHARP]).toEqual([true, true]);
  });

  test('read a module that says its tables as exactly those, and one that says none as writing none', () => {
    const written: Same<WrittenBy<'export', Named>, 'issues'> = true;
    const left: Same<ExcludedBy<'export', Named>, 'sessions'> = true;
    const none: Same<WrittenBy<'export', Empty>, never> = true;
    const noneVague: Same<VagueContribution<'export', Empty>, never> = true;
    expect([written, left, none, noneVague]).toEqual([true, true, true, true]);
  });

  test('are found vague in a module annotated with the interface, in both exports', () => {
    const vagueExport: Same<VagueContribution<'export', Annotated>, 'annotated'> = true;
    const vaguePersonal: Same<VagueContribution<'personalExport', Annotated>, 'annotated'> = true;
    expect([vagueExport, vaguePersonal]).toEqual([true, true]);
  });

  test('are not found vague in a module that names its tables', () => {
    const notVague: Same<VagueContribution<'export', Named>, never> = true;
    expect(notVague).toBe(true);
  });
});
