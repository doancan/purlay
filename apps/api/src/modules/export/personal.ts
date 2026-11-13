/**
 * A person's export of their own data (D-241): the workspace export's format and machinery — one NDJSON
 * file per table of the personal catalogue, each row as the database writes it, the files at `blobs/`, a
 * manifest last, read in one snapshot — about one person, across every workspace.
 *
 * - **Bounded to the person**, by each table's own column naming them or by the messages they wrote — the
 *   substitute for a request's `WorkspaceContext`: the tenant here is the person, and the bound names no
 *   workspace. What they wrote in a channel or a workspace they have since left is theirs and goes.
 * - **Their words that stand**: a deleted message is not offered back, and neither are its files.
 * - **Nobody else's**: no other person's row is written; a workspace or a channel only as their own rows
 *   name it (`personal-catalogue.ts`).
 */
import type { Executor, RawBuilder } from '@purlay/db';
import { sql } from '@purlay/db';
import { EXPORT_FORMAT, type PersonalExportManifest } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import type { ObjectStore } from '../../platform/storage';
import { snapshotOn } from '../../platform/transactions';
import { copyObjects, filesOf, readTable, schemaOf } from './export';
import type { PersonalCatalogue, PersonalTableExport } from './personal-catalogue';
import { exportDirectory } from './write';
import { currentRequest } from '../../platform/logging';
import type { WorkspaceAccessLifetime } from '../../platform/workspace-access-facts';
import { readWorkspaceAccessDecisions } from '../../platform/workspace-access';

/** The columns the catalogue lets go, and no other. */
const projection = (table: PersonalTableExport): RawBuilder<unknown> =>
  sql.join(
    Object.entries(table.columns)
      .filter(([, decided]) => decided === 'export')
      .map(([column]) => sql.ref(column)),
  );

/**
 * Exports the person into `target`: the tables in one snapshot, the files written as they come, the
 * manifest last. The directory is published; the caller archives it.
 */
export const exportPerson = async (
  dependencies: {
    readonly database: Executor;
    readonly clock: Clock;
    readonly log: Logger;
    readonly storage: ObjectStore;
    /** What the export holds, assembled from the core's contribution and the modules' (D-250). */
    readonly personalCatalogue: PersonalCatalogue;
    readonly sessionLifetime?: () => WorkspaceAccessLifetime;
  },
  person: { readonly id: string; readonly username: string },
  target: string,
): Promise<{
  readonly path: string;
  readonly manifest: PersonalExportManifest;
  readonly workspaceIds: readonly string[];
}> => {
  const { database, clock, log, storage, personalCatalogue } = dependencies;
  const directory = await exportDirectory(target);
  try {
    const { tables, schema, objects, workspaceIds } = await snapshotOn(database)(
      async (transaction) => {
        const counted: Record<string, number> = {};
        const absent = await personalCatalogue.absent(transaction);
        const potential = personalCatalogue.workspaces(person.id, absent);
        const candidates = await transaction
          .selectFrom('workspaces')
          .select(['id', 'access_policy_epoch'])
          .where(sql<boolean>`id in (${potential})`)
          .execute();
        const source = currentRequest();
        const governed = candidates.filter((row) => row.access_policy_epoch !== '0');
        const decisions =
          source?.sessionId === undefined || dependencies.sessionLifetime === undefined
            ? undefined
            : await readWorkspaceAccessDecisions(transaction, {
                sessionId: source.sessionId,
                userId: person.id,
                workspaceIds: governed.map((row) => row.id),
                now: clock.now(),
                lifetime: dependencies.sessionLifetime(),
              });
        const allowed = candidates
          .filter(
            (row) =>
              (source?.companySession === undefined ||
                source.companySession.workspaceId === row.id) &&
              (row.access_policy_epoch === '0' || decisions?.get(row.id)?.allowed === true),
          )
          .map((row) => row.id);
        const workspaces =
          allowed.length === 0
            ? sql`select id from workspaces where false`
            : sql`select id from workspaces where id in (${sql.join(allowed)})`;
        for (const name of personalCatalogue.order) {
          const table = personalCatalogue.table(name);
          if (absent.includes(name)) {
            counted[name] = 0;
            continue;
          }
          counted[name] = await readTable(
            transaction,
            name,
            {
              columns: projection(table),
              ...(await table.bounds(person.id, workspaces, transaction)),
            },
            directory.write,
          );
        }
        return {
          schema: await schemaOf(transaction),
          tables: counted,
          objects: await filesOf(
            transaction,
            sql`(${(await personalCatalogue.files(person.id, transaction)) ?? sql`false`}) and workspace_id in (${workspaces})`,
          ),
          workspaceIds: allowed,
        };
      },
    );
    // The snapshot has committed: the files are copied outside it, however slow the store.
    const blobs = await copyObjects(database, storage, objects, directory);
    const manifest: PersonalExportManifest = {
      format: EXPORT_FORMAT,
      exportedAt: clock.now().toISOString(),
      person: { id: person.id, username: person.username },
      schema,
      scope: 'person',
      tables,
      blobs,
    };
    await directory.seal(manifest, personalCatalogue.order);
    const path = await directory.publish();
    log.info('a person’s data exported', { userId: person.id, rows: tables, files: blobs.count });
    return { path, manifest, workspaceIds };
  } catch (error) {
    await directory.abandon();
    throw error;
  }
};
