/**
 * The workspace export's and the person's export's catalogues, put together (D-250): the core's contribution and
 * those of the modules this build carries. It is the one place that sees both sides, so it is where the sum is held
 * to the schema — a table of the generated schema that no contribution writes or names as left out is a compile
 * error here, as a column nobody decided is where that table is described.
 *
 * The modules' side is read off `bundledModules` itself: what a module's contribution writes is the names of its
 * `tables`, and what it leaves out is the keys of its `excluded`, so a module added to the build is held to the
 * schema without this file being edited.
 */
import type { Database } from '@purlay/db';
import { bundledModules, composition, type BundledModule } from './composition';
import { CORE_EXCLUDED, type CoreExcluded, type CoreWritten } from './modules/export/core-export';
import {
  CORE_PERSONAL_EXCLUDED,
  type CorePersonalExcluded,
  type CorePersonalWritten,
} from './modules/export/core-personal-export';

type Bundled = (typeof bundledModules)[number];
/** What a module's contribution to the export under `Slot` writes and what it leaves out, as table names. */
type WrittenBy<Slot extends 'export' | 'personalExport', Module> = Module extends {
  readonly [S in Slot]: { readonly tables: readonly { readonly name: infer Name }[] };
}
  ? Name
  : never;
type ExcludedBy<Slot extends 'export' | 'personalExport', Module> = Module extends {
  readonly [S in Slot]: { readonly excluded: infer Excluded };
}
  ? keyof Excluded
  : never;

type Undecided = Exclude<
  keyof Database,
  CoreWritten | CoreExcluded | WrittenBy<'export', Bundled> | ExcludedBy<'export', Bundled>
>;
/** True while every table is decided; while one is not, the next line does not compile, and names it. */
type EveryTableDecided = [Undecided] extends [never] ? true : { readonly undecided: Undecided };
const decided: EveryTableDecided = true;
export const EVERY_TABLE_DECIDED: boolean = decided;

const carried: readonly BundledModule[] = bundledModules;

/** Every table left out of an export and why: the core's and each module's. */
export const EXCLUDED_FROM_EXPORT: Readonly<Record<string, string>> = {
  ...CORE_EXCLUDED,
  ...Object.fromEntries(carried.flatMap((module) => Object.entries(module.export?.excluded ?? {}))),
};

/** The workspace export's catalogue for the modules a process runs (`composition.ts`). */
export const exportCatalogue = composition.exportCatalogue;

type PersonalUndecided = Exclude<
  keyof Database,
  | CorePersonalWritten
  | CorePersonalExcluded
  | WrittenBy<'personalExport', Bundled>
  | ExcludedBy<'personalExport', Bundled>
>;
/** The same for a person's export: while a table is undecided there, the next line does not compile, and names it. */
type EveryTableDecidedForPeople = [PersonalUndecided] extends [never]
  ? true
  : { readonly undecided: PersonalUndecided };
const decidedForPeople: EveryTableDecidedForPeople = true;
export const EVERY_TABLE_DECIDED_FOR_PEOPLE: boolean = decidedForPeople;

/** Every table left out of a person's export and why: the core's and each module's. */
export const EXCLUDED_FROM_PERSONAL_EXPORT: Readonly<Record<string, string>> = {
  ...CORE_PERSONAL_EXCLUDED,
  ...Object.fromEntries(
    carried.flatMap((module) => Object.entries(module.personalExport?.excluded ?? {})),
  ),
};

/** A person's export's catalogue for the modules a process runs (`composition.ts`). */
export const personalExportCatalogue = composition.personalExportCatalogue;
