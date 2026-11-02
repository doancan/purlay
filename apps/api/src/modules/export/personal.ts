/**
 * A person's export of their own data (D-241): the workspace export's format and machinery — one NDJSON
 * file per table of `PERSONAL_COLUMNS`, each row as the database writes it, the files at `blobs/`, a
 * manifest last, read in one snapshot — about one person, across every workspace.
 *
 * - **Bounded to the person**, by each table's own column naming them or by the messages they wrote — the
 *   substitute for a request's `WorkspaceContext`: the tenant here is the person, and the bound names no
 *   workspace. What they wrote in a channel or a workspace they have since left is theirs and goes.
 * - **Their words that stand**: a deleted message is not offered back, and neither are its files.
 * - **Nobody else's**: no other person's row is written; a workspace or a channel only as their own rows
 *   name it (`PERSONAL_COLUMNS`).
 */
import type { Executor, RawBuilder } from '@purlay/db';
import { sql } from '@purlay/db';
import { EXPORT_FORMAT, type PersonalExportManifest } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import type { ObjectStore } from '../../platform/storage';
import { snapshotOn } from '../../platform/transactions';
import { copyObjects, filesOf, readTable, schemaOf } from './export';
import { PERSONAL_COLUMNS, type PersonalTable } from './tables';
import { exportDirectory } from './write';

/** In the order a reader would want them: who, where, then what they did there. */
export const PERSONAL_TABLE_ORDER: readonly PersonalTable[] = [
  'users',
  'workspaces',
  'workspace_members',
  'channels',
  'channel_members',
  'messages',
  'reactions',
  'attachments',
  'saved_messages',
  'saved_searches',
  'thread_follows',
  'channel_bookmarks',
];

/** The messages the person wrote that stand: every bound of their words goes through this. */
const theirMessages = (userId: string): RawBuilder<unknown> =>
  sql`select id from messages where sender_id = ${userId} and deleted_at is null`;

/** The files they sent with those messages; one uploaded and never sent is gone within a day (D-109 §5). */
const theirFiles = (userId: string): RawBuilder<unknown> =>
  sql`uploader_id = ${userId} and message_id in (${theirMessages(userId)})`;

/** The channels the person's rows name, so each id in the export says which channel it was. */
const theirChannels = (userId: string): RawBuilder<unknown> => sql`
  select channel_id from channel_members where user_id = ${userId}
  union select channel_id from messages where id in (${theirMessages(userId)})
  union select channel_id from saved_messages where user_id = ${userId}
  union select channel_id from thread_follows where user_id = ${userId}
  union select channel_id from channel_bookmarks where added_by = ${userId}
`;

/** The workspaces the person's rows name. */
const theirWorkspaces = (userId: string): RawBuilder<unknown> => sql`
  select workspace_id from workspace_members where user_id = ${userId}
  union select workspace_id from channels where id in (${theirChannels(userId)})
  union select workspace_id from saved_searches where user_id = ${userId}
`;

/** Each table's rows of the person, and the order they are written in. */
const BOUNDS: Readonly<
  Record<PersonalTable, (userId: string) => { where: RawBuilder<unknown>; order: string }>
> = {
  users: (u) => ({ where: sql`id = ${u}`, order: 'id' }),
  workspaces: (u) => ({ where: sql`id in (${theirWorkspaces(u)})`, order: 'id' }),
  workspace_members: (u) => ({ where: sql`user_id = ${u}`, order: 'id' }),
  channels: (u) => ({ where: sql`id in (${theirChannels(u)})`, order: 'id' }),
  channel_members: (u) => ({ where: sql`user_id = ${u}`, order: 'id' }),
  messages: (u) => ({ where: sql`id in (${theirMessages(u)})`, order: 'id' }),
  reactions: (u) => ({ where: sql`user_id = ${u}`, order: 'id' }),
  attachments: (u) => ({ where: theirFiles(u), order: 'id' }),
  saved_messages: (u) => ({ where: sql`user_id = ${u}`, order: 'id' }),
  saved_searches: (u) => ({ where: sql`user_id = ${u}`, order: 'id' }),
  thread_follows: (u) => ({ where: sql`user_id = ${u}`, order: 'message_id' }),
  channel_bookmarks: (u) => ({ where: sql`added_by = ${u}`, order: 'id' }),
};

/** The columns `PERSONAL_COLUMNS` lets go, and no other. */
const projection = (table: PersonalTable): RawBuilder<unknown> =>
  sql.join(
    Object.entries(PERSONAL_COLUMNS[table])
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
  },
  person: { readonly id: string; readonly username: string },
  target: string,
): Promise<{ readonly path: string; readonly manifest: PersonalExportManifest }> => {
  const { database, clock, log, storage } = dependencies;
  const directory = await exportDirectory(target);
  try {
    const { tables, schema, objects } = await snapshotOn(database)(async (transaction) => {
      const counted: Record<string, number> = {};
      for (const table of PERSONAL_TABLE_ORDER) {
        counted[table] = await readTable(
          transaction,
          table,
          { columns: projection(table), ...BOUNDS[table](person.id) },
          directory.write,
        );
      }
      return {
        schema: await schemaOf(transaction),
        tables: counted,
        objects: await filesOf(transaction, theirFiles(person.id)),
      };
    });
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
    await directory.seal(manifest, PERSONAL_TABLE_ORDER);
    const path = await directory.publish();
    log.info('a person’s data exported', { userId: person.id, rows: tables, files: blobs.count });
    return { path, manifest };
  } catch (error) {
    await directory.abandon();
    throw error;
  }
};
