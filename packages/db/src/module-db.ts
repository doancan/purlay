import type { Kysely, Transaction } from 'kysely';
import type { DB } from './schema';
import type { TableOwner, TablesOf } from './table-owners';

/**
 * Exactly the tables a module owns, from `TABLE_OWNERS`, and the core tables it names: nothing else is in the type, so
 * a query of the module over another module's table, or a core table it did not name, does not compile (D-271,
 * `MODULES.md` §4). There is one such type to a module, in its own `schema.ts`.
 */
export type ModuleSchema<
  Module extends Exclude<TableOwner, 'core'>,
  CoreReads extends TablesOf<'core'>,
> = Pick<DB, TablesOf<Module> | CoreReads>;

/**
 * The handle a module's functions take: the same object the core hands every module, seen through the module's own
 * schema, so nothing is wrapped and no caller changes. It is a union because kysely's `Kysely<DB>` and `Transaction<DB>`
 * are not assignable to the other's narrower `Kysely<Schema>`, and the union makes either way of being given one work.
 *
 * A message that a table "is not assignable to `TableExpressionOrList<…>`" is this type refusing it.
 */
export type ModuleDb<Schema> = Kysely<Schema> | Transaction<Schema>;

/** A handle known to be inside a transaction, as `Transaction` is for the whole database. */
export type ModuleTransaction<Schema> = Transaction<Schema>;
