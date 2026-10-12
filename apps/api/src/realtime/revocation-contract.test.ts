/**
 * Nothing that removes visibility may do so without deciding what the open sockets
 * are told (D-85).
 *
 * A socket authorises once, at `SUBSCRIBE`; only a bus event ends it afterwards.
 * So every production statement that revokes a session, soft-deletes a user,
 * workspace or channel, or removes or changes a membership has to name the event
 * it publishes — or say, in writing and with an owner, why none is needed yet.
 * This test finds every such statement in the production source and holds each to
 * the table below. A new write path that is not in the table fails the build, and
 * so does a table row whose write path has gone: a mapping nobody can falsify is a
 * wish (`CONTRIBUTING.md` §6.2).
 *
 * It reads source rather than running the code because the failure it guards
 * against is a path that does not exist yet: Phase 1's remove-member, leave,
 * delete-channel and delete-user endpoints (#51, #98).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SCANNED = ['apps/api/src', 'packages/db/src'];

interface Source {
  readonly path: string;
  readonly text: string;
}

/** Where a visibility-removing write is made: the file and the function around it. */
interface Site {
  readonly site: string;
  readonly table: string;
}

const MEMBERSHIPS = ['workspace_members', 'channel_members'];
const SOFT_DELETED = ['users', 'workspaces', 'channels'];

/** The statement from its start to its first `execute`, or a bounded stretch. */
const statementFrom = (text: string, at: number): string => {
  const rest = text.slice(at, at + 800);
  const end = rest.search(/\.execute|\bexecuteTakeFirst/);
  return end === -1 ? rest : rest.slice(0, end);
};

const enclosing = (text: string, at: number): string => {
  const before = text.slice(0, at);
  const found = [...before.matchAll(/^(?:export\s+)?const\s+(\w+)\s*=/gm)].at(-1);
  return found?.[1] ?? '(module)';
};

/** Every statement in these sources that writes something a socket's access depends on. */
const visibilityWrites = (sources: readonly Source[]): Site[] => {
  const sites: Site[] = [];
  for (const { path, text } of sources) {
    const patterns = [
      /\.(updateTable|deleteFrom)\(\s*'(\w+)'\s*\)/g,
      /\b(update|delete\s+from)\s+(\w+)/gi,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const verb = (match[1] ?? '').toLowerCase();
        const table = match[2] ?? '';
        const statement = statementFrom(text, match.index);
        const deleting = verb.startsWith('delete');
        const sets = (column: string): boolean =>
          new RegExp(
            `\\.set\\(\\s*\\{[^}]*\\b${column}\\b|\\bset\\b[^;]*\\b${column}\\s*=`,
            'i',
          ).test(statement);

        const removes =
          (table === 'sessions' && (deleting || sets('revoked_at'))) ||
          (SOFT_DELETED.includes(table) && (deleting || sets('deleted_at'))) ||
          MEMBERSHIPS.includes(table);
        if (removes) sites.push({ site: `${path}#${enclosing(text, match.index)}`, table });
      }
    }
  }
  return sites;
};

/**
 * Each production write, and what it does about open sockets. `publishes` is a
 * function in `platform/events.ts` and `calledFrom` the file that calls it after
 * the write; or `none`, which must say why and name the issue that owns it.
 */
type Decision =
  { readonly publishes: string; readonly calledFrom: string } | { readonly none: string };

const DECISIONS: Readonly<Record<string, Decision>> = {
  // Sign out on this device; the caller publishes after the write (#194).
  'apps/api/src/modules/auth/sessions.ts#revokeSession': {
    publishes: 'publishSessionsEnded',
    calledFrom: 'apps/api/src/modules/auth/sign-in.ts',
  },
  // Sign out everywhere.
  'apps/api/src/modules/auth/sessions.ts#revokeAllSessions': {
    publishes: 'publishSessionsEnded',
    calledFrom: 'apps/api/src/modules/auth/sign-in.ts',
  },
  // Moves a read position and recounts what is unread. It changes what a person has
  // read, not what they may see, so no socket's access is affected (D-99 §4, #25).
  'apps/api/src/modules/channels/read-state.ts#markRead': {
    none: 'moves a read position and its counters; nobody gains or loses sight of a channel (#25)',
  },
  // A new message raises the unread counters of the channel's existing memberships. It
  // adds, removes and changes no membership, so nobody's access moves (D-99, #58).
  'apps/api/src/modules/messages/delivery.ts#recordDelivery': {
    none: 'raises the unread counters of existing memberships and changes no access (#58)',
  },
  // An edit that names somebody for the first time raises their unread mention count. It
  // changes no membership, so nobody's access moves (D-103 §5, #47).
  'apps/api/src/modules/messages/edit.ts#countMentions': {
    none: 'raises the mention counters of existing memberships and changes no access (#47)',
  },
  // Nothing calls it yet. It deletes rows that are already revoked (announced when
  // they were revoked) or past their expiry (the hub's own timer ends the socket).
  'packages/db/src/sessions.ts#purgeDeadSessions': {
    none: 'deletes only sessions already revoked or expired, whose sockets were told or time out by themselves (#231)',
  },
};

const sourcesIn = (dir: string): Source[] => {
  const found: Source[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const entry = dirent.name;
    const full = join(dir, entry);
    if (dirent.isDirectory()) {
      if (entry === 'node_modules' || entry === 'testing') continue;
      found.push(...sourcesIn(full));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      entry !== 'testing.ts' &&
      entry !== 'migrator.ts'
    ) {
      found.push({ path: relative(ROOT, full), text: readFileSync(full, 'utf8') });
    }
  }
  return found;
};

const production = (): Source[] => SCANNED.flatMap((dir) => sourcesIn(join(ROOT, dir)));

describe('every write that removes visibility decides what open sockets are told', () => {
  test('each production write is in the table, and each row in the table is a write that exists', () => {
    const found = visibilityWrites(production()).map((s) => s.site);
    // The control: the scan sees the writes that are known to exist. Without it an
    // empty result would pass as well as a working one.
    expect(found.length).toBeGreaterThan(0);

    const unlisted = [...new Set(found)].filter((site) => !(site in DECISIONS));
    expect(unlisted).toEqual([]);
    const stale = Object.keys(DECISIONS).filter((site) => !found.includes(site));
    expect(stale).toEqual([]);
  });

  test('a row that names an event is one that exists and is called after the write', () => {
    const events = readFileSync(join(ROOT, 'apps/api/src/platform/events.ts'), 'utf8');
    for (const [site, decision] of Object.entries(DECISIONS)) {
      if ('none' in decision) continue;
      expect(events).toContain(`export const ${decision.publishes} =`);
      const caller = readFileSync(join(ROOT, decision.calledFrom), 'utf8');
      expect(caller, site).toContain(`${decision.publishes}(`);
    }
  });

  test('a row that publishes nothing says why, and names who owns it', () => {
    for (const [site, decision] of Object.entries(DECISIONS)) {
      if (!('none' in decision)) continue;
      expect(decision.none, site).toMatch(/\(#\d+\)$/);
    }
  });

  /**
   * The check is only worth anything if it can fail. These plant the writes Phase 1
   * will add, in text that is not in the repository, and expect each to be found.
   */
  describe('finds the writes Phase 1 adds', () => {
    const planted = (text: string): string[] =>
      visibilityWrites([{ path: 'apps/api/src/modules/planted.ts', text }]).map((s) => s.table);

    test('removing a member, soft-deleting a user, a workspace, a channel; revoking by SQL', () => {
      expect(
        planted(`export const removeMember = async (db) => {
          await db.deleteFrom('workspace_members').where('user_id', '=', id).execute();
        };`),
      ).toEqual(['workspace_members']);
      expect(
        planted(`export const leave = async (db) => {
          await db.deleteFrom('channel_members').where('user_id', '=', id).execute();
        };`),
      ).toEqual(['channel_members']);
      expect(
        planted(`export const demote = async (db) => {
          await db.updateTable('workspace_members').set({ role: 'guest' }).execute();
        };`),
      ).toEqual(['workspace_members']);
      for (const table of ['users', 'workspaces', 'channels']) {
        expect(
          planted(`export const remove = async (db) => {
            await db.updateTable('${table}').set({ deleted_at: now }).where('id', '=', id).execute();
          };`),
        ).toEqual([table]);
      }
      expect(
        planted(`export const kill = async (db) => {
          await sql\`update sessions set revoked_at = now() where user_id = \${id}\`.execute(db);
        };`),
      ).toEqual(['sessions']);
      expect(
        planted(`export const sweep = async (db) => {
          await sql\`delete from sessions where expires_at < now()\`.execute(db);
        };`),
      ).toEqual(['sessions']);
    });

    test('and does not mistake a write that removes nothing for one that does', () => {
      expect(
        planted(`export const touch = async (db) => {
          await db.updateTable('sessions').set({ last_used_at: now }).where('id', '=', id).execute();
          await db.updateTable('users').set({ display_name: 'x' }).where('id', '=', id).execute();
          await db.updateTable('channels').set({ last_message_at: now }).execute();
        };`),
      ).toEqual([]);
    });
  });
});
