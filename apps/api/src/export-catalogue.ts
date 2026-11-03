/**
 * The workspace export's and the person's export's catalogues, put together (D-250): the core's contribution and
 * those of the modules this build carries. It is the one place that sees both sides, so it is where the sum is held
 * to the schema — a table of the generated schema that no contribution writes or names as left out is a compile
 * error here, as a column nobody decided is where that table is described.
 */
import type { Database } from '@purlay/db';
import { composition } from './composition';
import { CHAT_EXCLUDED, type ChatExcluded, type ChatWritten } from './features/chat/export';
import {
  CHAT_PERSONAL_EXCLUDED,
  type ChatPersonalExcluded,
  type ChatPersonalWritten,
} from './features/chat/personal-export';
import { CORE_EXCLUDED, type CoreExcluded, type CoreWritten } from './modules/export/core-export';
import {
  CORE_PERSONAL_EXCLUDED,
  type CorePersonalExcluded,
  type CorePersonalWritten,
} from './modules/export/core-personal-export';

type Undecided = Exclude<keyof Database, CoreWritten | CoreExcluded | ChatWritten | ChatExcluded>;
/** True while every table is decided; while one is not, the next line does not compile, and names it. */
type EveryTableDecided = [Undecided] extends [never] ? true : { readonly undecided: Undecided };
const decided: EveryTableDecided = true;
export const EVERY_TABLE_DECIDED: boolean = decided;

/** Every table left out of an export and why: the core's and each module's. */
export const EXCLUDED_FROM_EXPORT: Readonly<Record<string, string>> = {
  ...CORE_EXCLUDED,
  ...CHAT_EXCLUDED,
};

/** The workspace export's catalogue for the modules a process runs (`composition.ts`). */
export const exportCatalogue = composition.exportCatalogue;

type PersonalUndecided = Exclude<
  keyof Database,
  CorePersonalWritten | CorePersonalExcluded | ChatPersonalWritten | ChatPersonalExcluded
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
  ...CHAT_PERSONAL_EXCLUDED,
};

/** A person's export's catalogue for the modules a process runs (`composition.ts`). */
export const personalExportCatalogue = composition.personalExportCatalogue;
