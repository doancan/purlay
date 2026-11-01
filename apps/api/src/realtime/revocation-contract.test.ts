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

/** The sign-in library's model names for the tables above (`better-auth.ts`'s mapping). */
const LIBRARY_MODELS: Readonly<Record<string, string>> = { session: 'sessions', user: 'users' };

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
            // Up to the column without leaving the object — its `})` — rather than `[^}]*`: a
            // template's `${…}` before the column closed that, and an account's erasure went
            // unseen (D-139 §5).
            `\\.set\\(\\s*\\{(?:(?!\\}\\))[\\s\\S])*?\\b${column}\\b|\\bset\\b[^;]*\\b${column}\\s*=`,
            'i',
          ).test(statement);

        const removes =
          (table === 'sessions' && (deleting || sets('revoked_at'))) ||
          (SOFT_DELETED.includes(table) && (deleting || sets('deleted_at'))) ||
          MEMBERSHIPS.includes(table);
        if (removes) sites.push({ site: `${path}#${enclosing(text, match.index)}`, table });
      }
    }
    // The sign-in library's own writes (D-179): a delete through its adapter names the model, not
    // the table, and a revocation it makes because it is configured to appears only as its option.
    for (const match of text.matchAll(/\.(?:deleteMany|delete)\(\s*\{\s*model:\s*'(\w+)'/g)) {
      const table = LIBRARY_MODELS[match[1] ?? ''];
      if (table !== undefined) {
        sites.push({ site: `${path}#${enclosing(text, match.index)}`, table });
      }
    }
    for (const match of text.matchAll(/\brevokeSessionsOnPasswordReset:\s*true\b/g)) {
      sites.push({ site: `${path}#${enclosing(text, match.index)}`, table: 'sessions' });
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
  // Ending one of the caller's other sessions from the device list; the handler publishes after the write (D-193).
  'apps/api/src/modules/auth/devices.ts#endDeviceSession': {
    publishes: 'publishSessionsEnded',
    calledFrom: 'apps/api/src/ingress/http/devices.ts',
  },
  // A session the server's lifetime policy ended, deleted as it is read; the instance announces the one it deleted
  // (`endLapsed` in `better-auth.ts`, D-244).
  'apps/api/src/modules/auth/session-lifetime.ts#endLapsedSession': {
    publishes: 'publishSessionsEnded',
    calledFrom: 'apps/api/src/modules/auth/better-auth.ts',
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
  // "Mark unread from here" moves the same position back and recounts (D-212): what the person has read,
  // not what they may see.
  'apps/api/src/modules/channels/read-state.ts#markUnread': {
    none: 'moves a read position back and recounts; nobody gains or loses sight of a channel (#25)',
  },
  // Deep Work is a member's own quiet; it changes what interrupts them, not what they may see
  // (D-108, #59).
  'apps/api/src/modules/workspaces/deep-work.ts#setDeepWork': {
    none: 'sets a member’s own Deep Work; nobody gains or loses sight of anything (#59)',
  },
  // Setting a notification level changes what a member is told, not what they may see (D-107, #52).
  'apps/api/src/modules/channels/notification-level.ts#setNotificationLevel': {
    none: 'sets what an existing member is told about; nobody gains or loses sight of a channel (#52)',
  },
  // A star is a member's own mark on their membership: it changes where the channel is listed for
  // them, not who may see it (D-132).
  'apps/api/src/modules/channels/star.ts#setStarred': {
    none: 'marks an existing member’s own row; nobody gains or loses sight of a channel (#489)',
  },
  // Reading the inbox, or a thread, recounts the counters of the channels it touched. It changes
  // no membership, so nobody's access moves (D-106, D-147, #58).
  'apps/api/src/modules/notifications/notifications.ts#readAndCount': {
    none: 'recounts the counters of existing memberships and changes no access (#58)',
  },
  // A new message raises the unread counters of the channel's existing memberships. It
  // adds, removes and changes no membership, so nobody's access moves (D-99, #58).
  // Where a person's message and a feed's event both count (D-134 §6).
  'apps/api/src/modules/messages/delivery.ts#countArrival': {
    none: 'raises the unread counters of existing memberships and changes no access (#58)',
  },
  // An edit that names somebody for the first time raises their unread mention count. It
  // changes no membership, so nobody's access moves (D-103 §5, #47).
  'apps/api/src/modules/messages/edit.ts#countMentions': {
    none: 'raises the mention counters of existing memberships and changes no access (#47)',
  },
  // A deleted, purged or erased message takes back the unread counters it added. It changes no
  // membership, so nobody's access moves (D-103 §7, D-139 §2, #47).
  'apps/api/src/modules/messages/tombstone.ts#takeBack': {
    none: 'lowers the unread counters of existing memberships and changes no access (#47)',
  },
  // The \`sweep:sessions\` job calls it (D-30). It deletes rows that are already revoked
  // (announced when they were revoked) or past their expiry (the hub's own timer ends the socket).
  // A new role changes what a member may manage, not what they may see: every role sees the
  // same channels (§7.4, #51).
  'apps/api/src/modules/workspaces/members.ts#changeRole': {
    none: 'changes what a member may manage, not which channels they see (#51)',
  },
  // Out of the workspace — removed by an admin, or leaving (D-152), both through `takeOut`: their
  // sockets stop receiving every channel they could see in it.
  'apps/api/src/modules/workspaces/members.ts#takeOut': {
    publishes: 'publishAccessRevoked',
    calledFrom: 'apps/api/src/ingress/http/workspaces.ts',
  },
  // Out of one channel, by their own hand: their sockets stop receiving it and are told they left.
  'apps/api/src/modules/channels/settings.ts#leaveChannel': {
    publishes: 'publishAccessRevoked',
    calledFrom: 'apps/api/src/ingress/http/channels.ts',
  },
  // Out of one channel by somebody else's hand (D-172): their sockets stop receiving it and are told
  // they were removed. Naming oneself is leaving, through `leaveChannel` above.
  'apps/api/src/modules/channels/settings.ts#removeChannelMember': {
    publishes: 'publishAccessRevoked',
    calledFrom: 'apps/api/src/ingress/http/channels.ts',
  },
  // Archived: everyone watching it stops receiving it, on the channel's topic (D-123).
  'apps/api/src/modules/channels/settings.ts#archiveChannel': {
    publishes: 'publishChannelRevoked',
    calledFrom: 'apps/api/src/ingress/http/channels.ts',
  },
  // Brought back (D-232): it gives access back and takes none away. Its members are told on their own
  // topics to read their channels again (`CHANNELS_UPDATED`), which no revocation rule covers.
  'apps/api/src/modules/channels/settings.ts#restoreChannel': {
    none: 'it restores access and revokes none: its members read their channels again on CHANNELS_UPDATED (#846)',
  },
  // An account erased: its sessions revoked and the row soft-deleted in one transaction; the
  // ingress publishes after the commit (D-139 §5).
  'apps/api/src/modules/users/erasure.ts#eraseAccount': {
    publishes: 'publishUserDeleted',
    calledFrom: 'apps/api/src/ingress/http/auth.ts',
  },
  // The break-glass for the server administrator's password (`bun run admin:reset-password`): every
  // session of the account ends in its transaction. It runs as a process of its own with no bus, so it
  // publishes nothing; the liveness sweep (`realtime/liveness.ts`) ends the sockets of a session the
  // database removed within about half a minute (D-179 §4.8).
  'apps/api/src/modules/setup/reset-password.ts#resetAdministratorPassword': {
    none: 'a command-line process with no bus: its owner is the hub liveness sweep, which ends the sockets of a session the database removed within about half a minute (D-179 §4.8)',
  },
  // The sign-in library ends sessions itself (D-179). "Sign out my other devices" is our endpoint,
  // deleting by row id with a statement of its own, so it announces what it ended through the
  // publisher `createAuth` hands it — every page of ids, after its delete (#194).
  'apps/api/src/modules/auth/revoke-other-sessions.ts#revokeOtherSessionsById': {
    publishes: 'publishSessionsEnded',
    calledFrom: 'apps/api/src/modules/auth/better-auth.ts',
  },
  // Everything else the library ends — /sign-out, /revoke-session, /revoke-sessions, a password
  // reset — goes through its delete hooks, which run after the
  // commit and never for a rolled-back one, and announce each session (#194).
  'apps/api/src/modules/auth/better-auth.ts#createAuth': {
    publishes: 'publishSessionsEnded',
    calledFrom: 'apps/api/src/modules/auth/better-auth.ts',
  },
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
      // Its owner: an issue, or the decision that put the liveness sweep behind it.
      expect(decision.none, site).toMatch(/\((#\d+|D-\d+ §\d+(\.\d+)*)\)$/);
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

    test('and the sign-in library’s: a delete through its adapter, and a revocation it is told to make', () => {
      expect(
        planted(`export const others = createAuthEndpoint('/x', {}, async (ctx) => {
          await ctx.context.adapter.deleteMany({
            model: 'session',
            where: [{ field: 'userId', value: id }],
          });
        });`),
      ).toEqual(['sessions']);
      expect(
        planted(`export const gone = async (ctx) => {
          await ctx.context.adapter.delete({ model: 'user', where: [{ field: 'id', value: id }] });
        };`),
      ).toEqual(['users']);
      expect(
        planted(`export const createAuth = (deps) => betterAuth({
          emailAndPassword: { enabled: true, revokeSessionsOnPasswordReset: true },
        });`),
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
