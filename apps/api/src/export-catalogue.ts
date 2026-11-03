/**
 * The workspace export's catalogue, put together (D-250): the core's contribution and those of the modules this
 * build carries. It is the one place that sees both sides, so it is where the sum is held to the schema — a table
 * of the generated schema that no contribution writes or names as left out is a compile error here, as a column
 * nobody decided is where that table is described.
 */
import type { Database } from '@purlay/db';
import {
  chatExport,
  CHAT_EXCLUDED,
  type ChatExcluded,
  type ChatWritten,
} from './features/chat/export';
import { assembleCatalogue } from './modules/export/catalogue';
import {
  coreExport,
  CORE_EXCLUDED,
  type CoreExcluded,
  type CoreWritten,
} from './modules/export/core-export';

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

export const exportCatalogue = assembleCatalogue(coreExport, [chatExport]);
