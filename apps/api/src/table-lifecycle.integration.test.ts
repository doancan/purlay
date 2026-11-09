/**
 * `TABLE_LIFECYCLE` says what becomes of each table's rows, and nothing else checks that the code does it
 * (D-27, D-139, D-250): a table can be decided `deleted` with no deletion written, or `window` with no purge
 * reaching it, and compile and pass. This runs the decisions. For each table decided `deleted` it seeds the
 * cheapest row that names a person, runs the real `eraseAccount` with chat's hooks, and asks that the row is gone;
 * for each decided `window` or `swept` it seeds a row past its time, runs the real purge or sweep with a clock
 * after it, and asks the same; and, in a second world, a row still inside its time, which the sweep must leave
 * (a sweep that deletes too much is caught only by that control row). A decision that cannot be seeded cheaply is in `UNSEEDED_*`, with why.
 *
 * What is held is what is decided: a table decided `deleted`, `window` or `swept` that is in neither the probes nor the
 * allow-list fails, and so does a name in the allow-list that has since been probed or decided otherwise.
 * `anonymised` is held the same way (`KEPT_PROBES`, `UNSEEDED_KEPT`, and the cap on the latter): the erasure leaves
 * the row, which still names the tombstone. A deletion that goes further than the decision is what these catch.
 *
 * @needs-modules chat, issues
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  purgeDeadSessions,
  sql,
  TABLE_LIFECYCLE,
  type TableLifecycle,
  withRollback,
  type Transaction,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { chatUserErased } from './features/chat/channels/user-hooks';
import { mailMissedMessages } from './features/chat/notifications/missed-mail';
import { sendMessage } from './features/chat/messages/messages';
import { purgeRetention } from './features/chat/messages/retention-purge';
import { deliverScheduled } from './features/chat/scheduled/delivery';
import { sweepGitHubDeliveries, sweepLinkPreviews } from './features/chat/sweeps';
import { sweepObjectDeletions } from './modules/attachments/deletions';
import { storeUpload } from './modules/attachments/uploads';
import { recordAudit } from './modules/audit/audit';
import { addressCounterKey } from './modules/auth/magic-link';
import { sweepEmailSignIns } from './modules/jobs/jobs';
import { sweepInbox } from './modules/inbox/sweep';
import { OUTBOX_DEAD_KEPT_DAYS, sweepOutbox } from './platform/outbox-sweep';
import { eraseAccount } from './modules/users/erasure';
import { issuePassport } from './modules/workspaces/invitation-passport';
import { makeAndMailInvitation } from './modules/workspaces/invitation-mail';
import { createInvitation } from './modules/workspaces/invitations';
import { DAY_MS, fixedClock, HOUR_MS } from './platform/clock';
import { NO_LOG, type EventBus } from './platform/events';
import { requireWorkspaceMembership } from './platform/tenancy';
import { tokenDigest } from './platform/tokens';
import { atomicallyOn } from './platform/transactions';
import { aRoom, type Room } from './testing/rooms';
import { linkFile } from './testing/sent-files';
import { aSession } from './testing/signed-in';
import { aUniqueSlug } from './testing/users';
import { aMemoryStore } from './testing/storage';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-11-04T03:00:00.000Z');
const clock = fixedClock(NOW);
/** Past every window and every expiry a sweep keeps: the longest is the GitHub deliveries' thirty days. */
const LONG_AGO = new Date(NOW.getTime() - 90 * DAY_MS);
const WINDOW_DAYS = 30;

type Table = string;

/** Rows that have the value in the column. */
const countWhere = async (
  db: Transaction,
  table: Table,
  column: string,
  value: string,
): Promise<number> =>
  Number(
    (
      await sql<{ count: string }>`
        select count(*)::text as count from ${sql.table(table)} where ${sql.id(column)} = ${value}`.execute(
        db,
      )
    ).rows[0]?.count,
  );

const countLike = async (
  db: Transaction,
  table: Table,
  column: string,
  prefix: string,
): Promise<number> =>
  Number(
    (
      await sql<{ count: string }>`
        select count(*)::text as count from ${sql.table(table)} where ${sql.id(column)} like ${`${prefix}%`}`.execute(
        db,
      )
    ).rows[0]?.count,
  );

let tick = 0;
const anId = (at: Date = NOW): string => messageId(new Date(at.getTime() + (tick += 1)));

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};

const upload = async (
  db: Transaction,
  world: World,
  userId: string,
  id: string = anId(),
): Promise<string> => {
  await storeUpload(
    { atomically: atomicallyOn(db), storage: aMemoryStore(), log: NO_LOG },
    await requireWorkspaceMembership(db, userId, world.workspaceId),
    { id, name: 'plan.pdf', bytes: new Uint8Array(10).fill(7) },
  );
  return id;
};

/** A resolved incident in the world's channel, so any number stand beside each other (one open one per channel). */
const anIncident = async (db: Transaction, world: World, declaredBy: string): Promise<string> => {
  const id = anId();
  await db
    .insertInto('incidents')
    .values({
      id,
      workspace_id: world.workspaceId,
      channel_id: world.channelId,
      severity: 3,
      status: 'resolved',
      declared_by: declaredBy,
      declared_at: NOW,
      resolved_at: NOW,
    })
    .execute();
  return id;
};

/** A workspace of two people, bob who owns it and ada who is erased, and what the probes name. */
interface World {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly adaId: string;
  readonly bobId: string;
  readonly adaUsername: string;
  readonly sessionId: string;
  /** Bob's message, which ada's saved messages, follows and notifications name. */
  readonly bobsMessage: string;
  /** What the rows kept under the address are named by: read before the erasure replaces the address. */
  readonly counterKey: string;
  readonly adaEmail: string;
  readonly adaContext: Room['members'][string]['context'];
}

const aWorld = async (db: Transaction): Promise<World> => {
  const room = await aRoom(db, ['bob', 'ada']);
  const ada = member(room, 'ada');
  const bob = member(room, 'bob');
  const { sessionId } = await aSession(db, clock, ada.userId);
  const { email } = await db
    .selectFrom('users')
    .select('email')
    .where('id', '=', ada.userId)
    .executeTakeFirstOrThrow();
  const sent = await sendMessage(db, clock, bob.context, { id: anId(), content: 'hi' });
  return {
    workspaceId: room.workspaceId,
    channelId: room.channelId,
    adaId: ada.userId,
    bobId: bob.userId,
    adaUsername: ada.username,
    sessionId,
    bobsMessage: sent.message.id,
    counterKey: await addressCounterKey(email),
    adaEmail: email,
    adaContext: ada.context,
  };
};

/** A notice for ada from bob, about a subject of its own, made at `at` and read or not. */
const anInboxEntry = async (
  db: Transaction,
  world: World,
  entry: { readonly read: boolean; readonly at: Date; readonly subjectId?: string },
): Promise<void> => {
  await db
    .insertInto('inbox_entries')
    .values({
      id: anId(entry.at),
      workspace_id: world.workspaceId,
      user_id: world.adaId,
      module: 'issues',
      kind: 'issue_assigned',
      actor_id: world.bobId,
      subject_type: 'issue',
      subject_id: entry.subjectId ?? anId(),
      read_at: entry.read ? entry.at : null,
      created_at: entry.at,
    })
    .execute();
};

/** The cheapest rows of one table that a test can name, and how to count them afterwards. */
interface Probe {
  readonly seed: (db: Transaction, world: World) => Promise<void>;
  readonly rows: (db: Transaction, world: World) => Promise<number>;
}

const by = (
  table: Table,
  column: string,
  value: (world: World) => string,
  seed: Probe['seed'],
): Probe => ({
  seed,
  rows: async (db, world) => await countWhere(db, table, column, value(world)),
});

const adas = (world: World): string => world.adaId;

/** The names of a person's row in a table that keeps nobody else's: the column `user_id` of the world's person. */
const ofAda = (table: Table, seed: Probe['seed']): Probe => by(table, 'user_id', adas, seed);

const inWorkspace = (world: World): { workspace_id: string; channel_id: string } => ({
  workspace_id: world.workspaceId,
  channel_id: world.channelId,
});

/** Tables whose erasure is `deleted`: a row naming the person, and none left after `eraseAccount`. */
const ERASURE_PROBES: Readonly<Record<Table, Probe>> = {
  workspace_invitation_mail_attempts: {
    seed: async (db, world) => {
      await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', world.adaId)
        .execute();
      await makeAndMailInvitation(
        db,
        clock,
        await requireWorkspaceMembership(db, world.bobId, world.workspaceId),
        { emails: [world.adaEmail] },
        { on: true, appUrl: 'https://purlay.test' },
      );
    },
    rows: async (db, world) =>
      Number(
        (
          await db
            .selectFrom('workspace_invitation_mail_attempts as a')
            .innerJoin('workspace_invitation_recipients as r', 'r.id', 'a.recipient_id')
            .select((eb) => eb.fn.countAll().as('count'))
            .where('r.email', '=', world.adaEmail)
            .executeTakeFirstOrThrow()
        ).count,
      ),
  },
  accounts: ofAda('accounts', async (db, world) => {
    await db
      .insertInto('accounts')
      .values({ account_id: 'ada-github', provider_id: 'github', user_id: world.adaId })
      .execute();
  }),
  admin_email_verification: ofAda('admin_email_verification', async (db, world) => {
    await db
      .insertInto('admin_email_verification')
      .values({
        email: world.adaEmail,
        issued_at: NOW,
        token_digest: 'a'.repeat(64),
        user_id: world.adaId,
      })
      .execute();
  }),
  invitation_passports: {
    seed: async (db, world) => {
      const owner = await db
        .selectFrom('workspace_members')
        .select('user_id')
        .where('workspace_id', '=', world.workspaceId)
        .where('role', '=', 'owner')
        .executeTakeFirstOrThrow();
      const { token } = await createInvitation(
        db,
        clock,
        await requireWorkspaceMembership(db, owner.user_id, world.workspaceId),
      );
      await issuePassport(db, clock, { token, email: world.adaEmail });
    },
    rows: async (db, world) =>
      await countWhere(
        db,
        'invitation_passports',
        'address_digest',
        await tokenDigest(world.adaEmail),
      ),
  },
  inbox_entries: ofAda('inbox_entries', async (db, world) => {
    await anInboxEntry(db, world, { read: false, at: NOW });
  }),
  native_authorizations: ofAda('native_authorizations', async (db, world) => {
    await db
      .insertInto('native_authorizations')
      .values({
        id: anId(),
        user_id: world.adaId,
        code_digest: 'b'.repeat(64),
        challenge: 'c'.repeat(43),
        created_at: NOW,
        expires_at: new Date(NOW.getTime() + 120_000),
      })
      .execute();
  }),
  push_subscriptions: ofAda('push_subscriptions', async (db, world) => {
    await db
      .insertInto('push_subscriptions')
      .values({
        user_id: world.adaId,
        session_id: world.sessionId,
        endpoint: `https://push.example.test/${crypto.randomUUID()}`,
        p256dh: 'p',
        auth: 'a',
        server_key: 'k',
      })
      .execute();
  }),
  rate_limits: {
    seed: async (db, world) => {
      await db
        .insertInto('rate_limits')
        .values({ key: world.counterKey, count: 1, last_request: String(NOW.getTime()) })
        .execute();
    },
    rows: async (db, world) => await countLike(db, 'rate_limits', 'key', world.counterKey),
  },
  sessions: ofAda('sessions', async () => {
    // The world's own session is the row: the erasure ends it with the rest.
  }),
  two_factors: ofAda('two_factors', async (db, world) => {
    await db
      .insertInto('two_factors')
      .values({ user_id: world.adaId, secret: 's', backup_codes: '[]' })
      .execute();
  }),
  // A password reset's row holds the person's id in `value`.
  verifications: by('verifications', 'value', adas, async (db, world) => {
    await db
      .insertInto('verifications')
      .values({
        identifier: `reset-password:${crypto.randomUUID()}`,
        value: world.adaId,
        expires_at: new Date(NOW.getTime() + DAY_MS),
      })
      .execute();
  }),
  github_user_authorizations: ofAda('github_user_authorizations', async (db, world) => {
    await db
      .insertInto('github_user_authorizations')
      .values({
        id: anId(),
        user_id: world.adaId,
        github_user_id: '501',
        github_login: 'ada-dev',
        access_token_encrypted: 'sealed',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
  }),
  notifications: ofAda('notifications', async (db, world) => {
    await db
      .insertInto('notifications')
      .values({
        user_id: world.adaId,
        ...inWorkspace(world),
        message_id: world.bobsMessage,
        type: 'mention',
      })
      .execute();
  }),
  channel_departures: ofAda('channel_departures', async (db, world) => {
    await db
      .insertInto('channel_departures')
      .values({ channel_id: world.channelId, user_id: world.adaId, reason: 'left' })
      .execute();
  }),
  hidden_messages: ofAda('hidden_messages', async (db, world) => {
    await db
      .insertInto('hidden_messages')
      .values({ user_id: world.adaId, ...inWorkspace(world), message_id: world.bobsMessage })
      .execute();
  }),
  message_reminders: ofAda('message_reminders', async (db, world) => {
    await db
      .insertInto('message_reminders')
      .values({
        user_id: world.adaId,
        ...inWorkspace(world),
        message_id: world.bobsMessage,
        remind_at: new Date(NOW.getTime() + DAY_MS),
      })
      .execute();
  }),
  scheduled_messages: ofAda('scheduled_messages', async (db, world) => {
    await db
      .insertInto('scheduled_messages')
      .values({
        id: anId(),
        user_id: world.adaId,
        ...inWorkspace(world),
        content: 'later',
        send_at: new Date(NOW.getTime() + DAY_MS),
      })
      .execute();
  }),
  // A file reserved by a scheduled message goes with the message, by the key that cascades from it.
  scheduled_message_attachments: {
    seed: async (db, world) => {
      const scheduledId = anId();
      await db
        .insertInto('scheduled_messages')
        .values({
          id: scheduledId,
          user_id: world.adaId,
          ...inWorkspace(world),
          content: 'with a file',
          send_at: new Date(NOW.getTime() + DAY_MS),
        })
        .execute();
      await db
        .insertInto('scheduled_message_attachments')
        .values({
          scheduled_message_id: scheduledId,
          attachment_id: await upload(db, world, world.adaId),
          workspace_id: world.workspaceId,
        })
        .execute();
    },
    rows: async (db, world) =>
      await countWhere(db, 'scheduled_message_attachments', 'workspace_id', world.workspaceId),
  },
  missed_mail_letters: ofAda('missed_mail_letters', async (db, world) => {
    await db
      .insertInto('missed_mail_letters')
      .values({ user_id: world.adaId, sent_at: NOW, stop_digest: crypto.randomUUID() })
      .execute();
  }),
  saved_messages: ofAda('saved_messages', async (db, world) => {
    await db
      .insertInto('saved_messages')
      .values({
        id: anId(),
        user_id: world.adaId,
        ...inWorkspace(world),
        message_id: world.bobsMessage,
      })
      .execute();
  }),
  saved_searches: ofAda('saved_searches', async (db, world) => {
    await db
      .insertInto('saved_searches')
      .values({
        id: anId(),
        name: 'mine',
        query: JSON.stringify({ q: 'x' }),
        user_id: world.adaId,
        workspace_id: world.workspaceId,
      })
      .execute();
  }),
  channel_groups: ofAda('channel_groups', async (db, world) => {
    await db
      .insertInto('channel_groups')
      .values({
        id: anId(),
        workspace_id: world.workspaceId,
        user_id: world.adaId,
        name: 'Finance',
      })
      .execute();
  }),
  channel_group_channels: ofAda('channel_group_channels', async (db, world) => {
    const groupId = anId();
    await db
      .insertInto('channel_groups')
      .values({
        id: groupId,
        workspace_id: world.workspaceId,
        user_id: world.adaId,
        name: 'Operations',
      })
      .execute();
    await db
      .insertInto('channel_group_channels')
      .values({
        channel_id: world.channelId,
        user_id: world.adaId,
        group_id: groupId,
      })
      .execute();
  }),
  channel_read_scopes: ofAda('channel_read_scopes', async (db, world) => {
    await db
      .insertInto('channel_read_scopes')
      .values({ channel_id: world.channelId, user_id: world.adaId, unread_since: NOW })
      .onConflict((conflict) =>
        conflict.columns(['channel_id', 'user_id']).doUpdateSet({ unread_since: NOW }),
      )
      .execute();
  }),
  thread_reads: ofAda('thread_reads', async (db, world) => {
    await db
      .insertInto('thread_reads')
      .values({
        channel_id: world.channelId,
        user_id: world.adaId,
        root_id: world.bobsMessage,
        last_read_message_id: world.bobsMessage,
        read_at: NOW,
      })
      .execute();
  }),
  thread_follows: ofAda('thread_follows', async (db, world) => {
    await db
      .insertInto('thread_follows')
      .values({
        user_id: world.adaId,
        ...inWorkspace(world),
        message_id: world.bobsMessage,
        following: true,
      })
      .execute();
  }),
};

/**
 * Tables decided `deleted` that this does not seed, and why. **This list may only shrink**: a table is added to it
 * only by a person who says why it cannot be seeded cheaply, and leaves it the day it is probed.
 */
const UNSEEDED_ERASURE: Readonly<Record<Table, string>> = {};

/**
 * Tables decided `anonymised` whose row the erasure must leave: a row that names the person, counted by the column
 * that names them, which the soft deletion keeps pointing at the same (anonymised) account.
 */
const KEPT_PROBES: Readonly<Record<Table, Probe>> = {
  workspace_invitation_recipients: by(
    'workspace_invitation_recipients',
    'created_by',
    adas,
    async (db, world) => {
      await db
        .insertInto('workspace_invitation_recipients')
        .values({
          id: anId(),
          workspace_id: world.workspaceId,
          email: 'external@example.test',
          locale: 'en',
          created_at: NOW,
          created_by: world.adaId,
        })
        .execute();
    },
  ),
  users: by('users', 'id', adas, async () => {
    // Ada is the row.
  }),
  workspace_members: ofAda('workspace_members', async () => {
    // The room made it.
  }),
  channel_members: ofAda('channel_members', async () => {
    // The room made it.
  }),
  messages: by('messages', 'sender_id', adas, async (db, world) => {
    await sendMessage(db, clock, world.adaContext, { id: anId(), content: 'mine' });
  }),
  attachments: by('attachments', 'uploader_id', adas, async (db, world) => {
    await upload(db, world, world.adaId);
  }),
  audit_log: by('audit_log', 'actor_user_id', adas, async (db, world) => {
    await recordAudit(db, clock, {
      workspaceId: world.workspaceId,
      actorUserId: world.adaId,
      action: 'workspace.renamed',
      targetType: 'workspace',
      targetId: world.workspaceId,
    });
  }),
  workspace_modules: by('workspace_modules', 'changed_by', adas, async (db, world) => {
    await db
      .insertInto('workspace_modules')
      .values({
        workspace_id: world.workspaceId,
        module: 'issues',
        state: 'off',
        source: 'operator',
        changed_by: world.adaId,
        changed_at: NOW,
      })
      .execute();
  }),
  suspended_modules: by('suspended_modules', 'suspended_by', adas, async (db, world) => {
    await db
      .insertInto('suspended_modules')
      .values({
        module: 'issues',
        reason: 'misbehaving',
        source: 'operator',
        suspended_by: world.adaId,
        suspended_at: NOW,
      })
      .execute();
  }),
  channel_bookmarks: by('channel_bookmarks', 'added_by', adas, async (db, world) => {
    await db
      .insertInto('channel_bookmarks')
      .values({
        id: anId(),
        ...inWorkspace(world),
        added_by: world.adaId,
        title: 'docs',
        url: 'https://example.test/docs',
      })
      .execute();
  }),
  issues: by('issues', 'created_by', adas, async (db, world) => {
    await db
      .insertInto('issues')
      .values({
        id: anId(),
        workspace_id: world.workspaceId,
        title: 'an issue',
        created_by: world.adaId,
      })
      .execute();
  }),
  personal_exports: ofAda('personal_exports', async (db, world) => {
    await db
      .insertInto('personal_exports')
      .values({ id: anId(), user_id: world.adaId, status: 'pending', created_at: NOW })
      .execute();
  }),
  server_audit_log: by('server_audit_log', 'actor_user_id', adas, async (db, world) => {
    await db
      .insertInto('server_audit_log')
      .values({ id: anId(), actor_user_id: world.adaId, action: 'server.settings.changed' })
      .execute();
  }),
  workspace_exports: by('workspace_exports', 'requested_by', adas, async (db, world) => {
    await db
      .insertInto('workspace_exports')
      .values({
        id: anId(),
        workspace_id: world.workspaceId,
        requested_by: world.adaId,
        status: 'pending',
        created_at: NOW,
      })
      .execute();
  }),
  workspace_invitations: by('workspace_invitations', 'created_by', adas, async (db, world) => {
    await db
      .insertInto('workspace_invitations')
      .values({
        id: anId(),
        workspace_id: world.workspaceId,
        token_hash: 'd'.repeat(64),
        created_by: world.adaId,
        created_at: NOW,
        expires_at: new Date(NOW.getTime() + DAY_MS),
      })
      .execute();
  }),
  workspaces: by('workspaces', 'created_by', adas, async (db, world) => {
    await db
      .insertInto('workspaces')
      .values({ name: 'Ada’s', slug: aUniqueSlug('ada'), created_by: world.adaId })
      .execute();
  }),
  channels: by('channels', 'created_by', adas, async (db, world) => {
    await db
      .insertInto('channels')
      .values({ workspace_id: world.workspaceId, name: 'ada-made', created_by: world.adaId })
      .execute();
  }),
  github_app_handshakes: ofAda('github_app_handshakes', async (db, world) => {
    await db
      .insertInto('github_app_handshakes')
      .values({
        state_digest: crypto.randomUUID(),
        user_id: world.adaId,
        workspace_id: world.workspaceId,
        purpose: 'install',
        expires_at: new Date(NOW.getTime() + DAY_MS),
      })
      .execute();
  }),
  // An organisation's login stays with the installation: the hook replaces only a personal account's.
  github_app_installations: by(
    'github_app_installations',
    'connected_by',
    adas,
    async (db, world) => {
      await db
        .insertInto('github_app_installations')
        .values({
          id: anId(),
          workspace_id: world.workspaceId,
          installation_id: '4242',
          account_login: 'acme',
          account_type: 'Organization',
          connected_by: world.adaId,
          connected_at: NOW,
        })
        .execute();
    },
  ),
  github_integrations: by('github_integrations', 'created_by', adas, async (db, world) => {
    await db
      .insertInto('github_integrations')
      .values({ id: anId(), workspace_id: world.workspaceId, created_by: world.adaId })
      .execute();
  }),
  github_links: by('github_links', 'created_by', adas, async (db, world) => {
    await db
      .insertInto('github_links')
      .values({
        id: anId(),
        ...inWorkspace(world),
        root_id: world.bobsMessage,
        repository_id: '77',
        repository_full_name: 'acme/api',
        kind: 'issue',
        number: 1,
        title: 'an item',
        state: 'open',
        state_at: NOW,
        origin: 'linked',
        created_by: world.adaId,
        created_at: NOW,
      })
      .execute();
  }),
  github_operations: by('github_operations', 'actor_id', adas, async (db, world) => {
    await db
      .insertInto('github_operations')
      .values({
        id: anId(),
        workspace_id: world.workspaceId,
        actor_id: world.adaId,
        client_request_id: crypto.randomUUID(),
        content_digest: 'ab'.repeat(32),
        root_id: world.bobsMessage,
        repository_id: '77',
        repository_full_name: 'acme/api',
        marker: crypto.randomUUID(),
        status: 'pending',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
  }),
  github_repo_feeds: by('github_repo_feeds', 'created_by', adas, async (db, world) => {
    await db
      .insertInto('github_repo_feeds')
      .values({
        id: anId(),
        ...inWorkspace(world),
        repository_full_name: 'acme/api',
        secret_encrypted: 'sealed',
        events: ['push'],
        created_by: world.adaId,
      })
      .execute();
  }),
  // An incident's three tables are kept by what each says of ada: who declared it, who was added, who acted.
  incidents: by('incidents', 'declared_by', adas, async (db, world) => {
    await anIncident(db, world, world.adaId);
  }),
  incident_responders: ofAda('incident_responders', async (db, world) => {
    const incidentId = await anIncident(db, world, world.bobId);
    await db
      .insertInto('incident_responders')
      .values({
        incident_id: incidentId,
        channel_id: world.channelId,
        user_id: world.adaId,
        added_by: world.bobId,
        added_at: NOW,
      })
      .execute();
  }),
  incident_updates: by('incident_updates', 'actor_id', adas, async (db, world) => {
    const incidentId = await anIncident(db, world, world.bobId);
    await db
      .insertInto('incident_updates')
      .values({
        id: anId(),
        incident_id: incidentId,
        kind: 'declared',
        to_value: 'investigating',
        actor_id: world.adaId,
        at: NOW,
      })
      .execute();
  }),
  incoming_webhooks: by('incoming_webhooks', 'created_by', adas, async (db, world) => {
    await db
      .insertInto('incoming_webhooks')
      .values({
        id: anId(),
        ...inWorkspace(world),
        name: 'deploys',
        secret_digest: crypto.randomUUID(),
        created_by: world.adaId,
        created_at: NOW,
      })
      .execute();
  }),
  mentions: by('mentions', 'mentioned_user_id', adas, async (db, world) => {
    await db
      .insertInto('mentions')
      .values({
        ...inWorkspace(world),
        message_id: world.bobsMessage,
        mentioned_user_id: world.adaId,
      })
      .execute();
  }),
  // A version hangs on its message and names nobody: it is ada's by the sender of the message it replaced.
  message_versions: {
    seed: async (db, world) => {
      const sent = await sendMessage(db, clock, world.adaContext, { id: anId(), content: 'v2' });
      await db
        .insertInto('message_versions')
        .values({
          id: anId(),
          ...inWorkspace(world),
          message_id: sent.message.id,
          content: 'v1',
          replaced_at: NOW,
        })
        .execute();
    },
    rows: async (db, world) =>
      Number(
        (
          await db
            .selectFrom('message_versions')
            .innerJoin('messages', 'messages.id', 'message_versions.message_id')
            .select((eb) => eb.fn.countAll<string>().as('count'))
            .where('messages.sender_id', '=', world.adaId)
            .executeTakeFirstOrThrow()
        ).count,
      ),
  },
  pinned_messages: by('pinned_messages', 'pinned_by', adas, async (db, world) => {
    await db
      .insertInto('pinned_messages')
      .values({ ...inWorkspace(world), message_id: world.bobsMessage, pinned_by: world.adaId })
      .execute();
  }),
  reactions: ofAda('reactions', async (db, world) => {
    await db
      .insertInto('reactions')
      .values({ message_id: world.bobsMessage, user_id: world.adaId, emoji: '👍' })
      .execute();
  }),
};

/**
 * Tables decided `anonymised` that `KEPT_PROBES` does not seed, and why. **This list may only shrink**, and a test
 * holds its size to `MAX_UNSEEDED_KEPT`: a table joins it only with the cap raised in the same change, by a person
 * who says in one line why a row naming the person cannot be seeded cheaply.
 */
const UNSEEDED_KEPT: Readonly<Record<Table, string>> = {};
const MAX_UNSEEDED_KEPT = 0;

/** The jobs that delete by time, as `bun run job <name>` calls them, over the test's transaction and the clock. */
const SWEEPS = {
  'purge:retention': async (db: Transaction) => {
    await purgeRetention({ database: db, clock, log: NO_LOG, storage: aMemoryStore() });
  },
  'sweep:email-sign-ins': async (db: Transaction) => {
    await sweepEmailSignIns({ database: db, clock });
  },
  'sweep:inbox': async (db: Transaction) => {
    await sweepInbox({ database: db, clock });
  },
  'sweep:outbox': async (db: Transaction) => {
    await sweepOutbox({ database: db, clock, deadKeptDays: OUTBOX_DEAD_KEPT_DAYS });
  },
  'sweep:sessions': async (db: Transaction) => {
    await purgeDeadSessions(db, NOW, 1_000);
  },
  'sweep:link-previews': async (db: Transaction) => {
    await sweepLinkPreviews({ database: db, clock });
  },
  'sweep:github-deliveries': async (db: Transaction) => {
    await sweepGitHubDeliveries({ database: db, clock });
  },
  'sweep:deletions': async (db: Transaction) => {
    await sweepObjectDeletions({
      database: db,
      atomically: atomicallyOn(db),
      log: NO_LOG,
      storage: aMemoryStore(),
    });
  },
  'mail:missed': async (db: Transaction) => {
    await mailMissedMessages({
      database: db,
      clock,
      log: NO_LOG,
      send: undefined,
      appUrl: 'https://purlay.example.test',
    });
  },
  // The scheduler's delivery loop ends by deleting the scheduled messages that are done and a month old.
  'deliver:scheduled': async (db: Transaction) => {
    const bus: EventBus = {
      publish: () => Promise.resolve(),
      subscribe: () => false,
      unsubscribe: () => undefined,
      forget: () => undefined,
    };
    await deliverScheduled({ database: db, clock, bus, log: NO_LOG });
  },
} as const;

/**
 * A row a retention probe seeds, told from the others by what it holds and not by an id it never learns. `at` is
 * when the row was made, received, issued or lapsed, for the sweeps that count from it; `until` is when it
 * expires, for those that delete at the expiry itself.
 */
interface Row {
  readonly mark: string;
  readonly id: string;
  readonly at: Date;
  readonly until: Date;
}

interface RetentionProbe {
  readonly job: keyof typeof SWEEPS;
  readonly seed: (db: Transaction, world: World, row: Row) => Promise<void>;
  readonly rows: (db: Transaction, row: Row) => Promise<number>;
}

const aMark = (): string => crypto.randomUUID().replaceAll('-', '').repeat(2);

/** Past the time of every sweep. */
const EXPIRED: Row = { mark: aMark(), id: messageId(LONG_AGO), at: LONG_AGO, until: LONG_AGO };
/**
 * Inside the time of every sweep: made an hour ago, which no window and no margin has passed (the shortest is the
 * day that a sign-in's rows are kept past their expiry), and expiring in an hour, which no expiry has.
 */
const KEPT: Row = {
  mark: aMark(),
  id: messageId(new Date(NOW.getTime() - HOUR_MS)),
  at: new Date(NOW.getTime() - HOUR_MS),
  until: new Date(NOW.getTime() + HOUR_MS),
};

/** A row found by the column that holds its mark. */
const marked = (
  job: RetentionProbe['job'],
  table: Table,
  column: string,
  seed: RetentionProbe['seed'],
  held: (row: Row) => string = (row) => row.mark,
): RetentionProbe => ({
  job,
  seed,
  rows: async (db, row) => await countWhere(db, table, column, held(row)),
});

/** Tables decided `window` or `swept`: a row seeded as `EXPIRED` and one as `KEPT`, by the same code. */
const RETENTION_PROBES: Readonly<Record<Table, RetentionProbe>> = {
  messages: marked('purge:retention', 'messages', 'content', async (db, world, row) => {
    await db
      .updateTable('workspaces')
      .set({ retention_days: WINDOW_DAYS })
      .where('id', '=', world.workspaceId)
      .execute();
    await sendMessage(db, fixedClock(row.at), world.adaContext, {
      id: anId(row.at),
      content: row.mark,
    });
  }),
  // A file goes with the message it was sent with, past the same window.
  attachments: {
    job: 'purge:retention',
    seed: async (db, world, row) => {
      const sent = await sendMessage(db, fixedClock(row.at), world.adaContext, {
        id: anId(row.at),
        content: 'with a file',
      });
      await upload(db, world, world.adaId, row.id);
      await linkFile(db, {
        id: row.id,
        workspaceId: world.workspaceId,
        messageId: sent.message.id,
        channelId: world.channelId,
      });
    },
    rows: async (db, row) => await countWhere(db, 'attachments', 'id', row.id),
  },
  // Read 90 days ago, past the 30 days a read notice is kept, against one read an hour ago (`modules/inbox/sweep.ts`).
  inbox_entries: {
    job: 'sweep:inbox',
    seed: async (db, world, row) => {
      await anInboxEntry(db, world, { read: true, at: row.at, subjectId: row.id });
    },
    rows: async (db, row) => await countWhere(db, 'inbox_entries', 'subject_id', row.id),
  },
  // Delivered long ago, past the day a finished fact is kept, against one delivered an hour ago (`platform/outbox-sweep.ts`).
  outbox: {
    job: 'sweep:outbox',
    seed: async (db, world, row) => {
      await db
        .insertInto('outbox')
        .values({
          id: row.id,
          fact_id: anId(row.at),
          workspace_id: world.workspaceId,
          type: 'notes.created',
          producer: 'notes',
          consumer: 'wiki',
          payload: JSON.stringify({ noteId: 'n', title: 't' }),
          state: 'delivered',
          next_attempt_at: row.at,
          created_at: row.at,
          finished_at: row.at,
          expires_at: row.at,
        })
        .execute();
    },
    rows: async (db, row) => await countWhere(db, 'outbox', 'id', row.id),
  },
  // The setup's one address link: one row, which is why the kept row is seeded in a world of its own.
  admin_email_verification: marked(
    'sweep:email-sign-ins',
    'admin_email_verification',
    'token_digest',
    async (db, world, row) => {
      await db
        .insertInto('admin_email_verification')
        .values({
          email: world.adaEmail,
          issued_at: row.at,
          token_digest: row.mark,
          user_id: world.adaId,
        })
        .execute();
    },
  ),
  invitation_passports: marked(
    'sweep:email-sign-ins',
    'invitation_passports',
    'address_digest',
    async (db, world, row) => {
      const { invitation } = await createInvitation(
        db,
        clock,
        await requireWorkspaceMembership(db, world.bobId, world.workspaceId),
      );
      await db
        .insertInto('invitation_passports')
        .values({
          id: anId(),
          invitation_id: invitation.id,
          kind: 'email',
          address_digest: row.mark,
          expires_at: row.at,
        })
        .execute();
    },
  ),
  native_authorizations: marked(
    'sweep:email-sign-ins',
    'native_authorizations',
    'code_digest',
    async (db, world, row) => {
      await db
        .insertInto('native_authorizations')
        .values({
          id: anId(),
          user_id: world.adaId,
          code_digest: row.mark,
          challenge: 'c'.repeat(43),
          created_at: row.at,
          expires_at: row.at,
        })
        .execute();
    },
  ),
  rate_limits: marked('sweep:email-sign-ins', 'rate_limits', 'key', async (db, _world, row) => {
    await db
      .insertInto('rate_limits')
      .values({ key: row.mark, count: 1, last_request: String(row.at.getTime()) })
      .execute();
  }),
  verifications: marked(
    'sweep:email-sign-ins',
    'verifications',
    'identifier',
    async (db, world, row) => {
      await db
        .insertInto('verifications')
        .values({ identifier: row.mark, value: world.adaId, expires_at: row.at })
        .execute();
    },
  ),
  sessions: marked('sweep:sessions', 'sessions', 'token_hash', async (db, world, row) => {
    await db
      .insertInto('sessions')
      .values({ user_id: world.adaId, token_hash: row.mark, expires_at: row.until })
      .execute();
  }),
  link_previews: marked(
    'sweep:link-previews',
    'link_previews',
    'url_hash',
    async (db, _world, row) => {
      await db
        .insertInto('link_previews')
        .values({
          url: `https://example.test/${row.mark}`,
          url_hash: row.mark,
          payload: JSON.stringify({}),
          expires_at: row.until,
        })
        .execute();
    },
  ),
  github_app_deliveries: marked(
    'sweep:github-deliveries',
    'github_app_deliveries',
    'delivery_id',
    async (db, _world, row) => {
      await db
        .insertInto('github_app_deliveries')
        .values({ delivery_id: row.mark, body_digest: 'ab'.repeat(32), received_at: row.at })
        .execute();
    },
  ),
  github_app_handshakes: marked(
    'sweep:github-deliveries',
    'github_app_handshakes',
    'state_digest',
    async (db, world, row) => {
      await db
        .insertInto('github_app_handshakes')
        .values({
          state_digest: row.mark,
          user_id: world.adaId,
          workspace_id: world.workspaceId,
          purpose: 'install',
          expires_at: row.until,
        })
        .execute();
    },
  ),
  github_deliveries: marked(
    'sweep:github-deliveries',
    'github_deliveries',
    'delivery_id',
    async (db, world, row) => {
      const feedId = anId();
      await db
        .insertInto('github_repo_feeds')
        .values({
          id: feedId,
          ...inWorkspace(world),
          repository_full_name: 'acme/api',
          secret_encrypted: 'sealed',
          events: ['push'],
        })
        .execute();
      await db
        .insertInto('github_deliveries')
        .values({ feed_id: feedId, delivery_id: row.mark, received_at: row.at })
        .execute();
    },
  ),
  github_operations: marked(
    'sweep:github-deliveries',
    'github_operations',
    'marker',
    async (db, world, row) => {
      await db
        .insertInto('github_operations')
        .values({
          id: anId(),
          workspace_id: world.workspaceId,
          actor_id: world.adaId,
          client_request_id: crypto.randomUUID(),
          content_digest: 'ab'.repeat(32),
          root_id: world.bobsMessage,
          repository_id: '77',
          repository_full_name: 'acme/api',
          marker: row.mark,
          status: 'pending',
          created_at: row.at,
          updated_at: row.at,
        })
        .execute();
    },
  ),
  // Due at the database's `now()`, not the test's clock: a key is due when the row is written, or an hour on, as an
  // upload's keys are written ahead of its object (`UPLOAD_GRACE`).
  object_deletions: marked(
    'sweep:deletions',
    'object_deletions',
    'storage_key',
    async (db, _world, row) => {
      await db
        .insertInto('object_deletions')
        .values({
          storage_key: `w/${row.mark}`,
          ...(row.until > NOW ? { due_at: sql<Date>`now() + interval '1 hour'` } : {}),
        })
        .execute();
    },
    (row) => `w/${row.mark}`,
  ),
  missed_mail_letters: marked(
    'mail:missed',
    'missed_mail_letters',
    'stop_digest',
    async (db, world, row) => {
      await db
        .insertInto('missed_mail_letters')
        .values({ user_id: world.adaId, sent_at: row.at, stop_digest: row.mark })
        .execute();
    },
  ),
  scheduled_messages: {
    job: 'deliver:scheduled',
    seed: async (db, world, row) => {
      await db
        .insertInto('scheduled_messages')
        .values({
          id: row.id,
          user_id: world.adaId,
          ...inWorkspace(world),
          content: 'done',
          send_at: row.at,
          state: 'sent',
          created_at: row.at,
          updated_at: row.at,
        })
        .execute();
    },
    rows: async (db, row) => await countWhere(db, 'scheduled_messages', 'id', row.id),
  },
};

/** Tables decided `window` or `swept` that this does not seed, and why. **This list may only shrink**, as the other. */
const UNSEEDED_RETENTION: Readonly<Record<Table, string>> = {};

describe('integration: what TABLE_LIFECYCLE decides is what the code does', () => {
  const decided: [Table, TableLifecycle][] = Object.entries(TABLE_LIFECYCLE);
  const tablesWhere = (matches: (lifecycle: TableLifecycle) => boolean): string[] =>
    decided.filter(([, lifecycle]) => matches(lifecycle)).map(([table]) => table);
  const erasedByDeletion = tablesWhere(({ erasure }) => erasure === 'deleted');
  const keptByErasure = tablesWhere(({ erasure }) => erasure === 'anonymised');

  test('every table decided `deleted` is probed or allow-listed, and the allow-list holds nothing else', () => {
    const unheld = erasedByDeletion.filter(
      (table) => !(table in ERASURE_PROBES) && !(table in UNSEEDED_ERASURE),
    );
    expect(unheld).toEqual([]);
    const stale = [...Object.keys(ERASURE_PROBES), ...Object.keys(UNSEEDED_ERASURE)].filter(
      (table) => !erasedByDeletion.includes(table),
    );
    expect(stale).toEqual([]);
    expect(Object.keys(UNSEEDED_ERASURE).filter((table) => table in ERASURE_PROBES)).toEqual([]);
  });

  test('every table decided `anonymised` is probed or allow-listed, and the allow-list holds nothing else and stays under its cap', () => {
    const unheld = keptByErasure.filter(
      (table) => !(table in KEPT_PROBES) && !(table in UNSEEDED_KEPT),
    );
    expect(unheld).toEqual([]);
    const stale = [...Object.keys(KEPT_PROBES), ...Object.keys(UNSEEDED_KEPT)].filter(
      (table) => !keptByErasure.includes(table),
    );
    expect(stale).toEqual([]);
    expect(Object.keys(UNSEEDED_KEPT).filter((table) => table in KEPT_PROBES)).toEqual([]);
    expect(Object.keys(UNSEEDED_KEPT).length).toBeLessThanOrEqual(MAX_UNSEEDED_KEPT);
  });

  test('the account’s erasure deletes the rows of each table decided `deleted`, and leaves each `anonymised` one it can seed', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const seeded: Record<Table, Probe> = { ...ERASURE_PROBES, ...KEPT_PROBES };
      for (const probe of Object.values(seeded)) await probe.seed(db, world);
      // Seeded for real: a probe that found nothing before the erasure holds nothing after it.
      const before: Record<Table, number> = {};
      for (const [table, probe] of Object.entries(seeded)) {
        before[table] = await probe.rows(db, world);
      }
      expect(Object.entries(before).filter(([, rows]) => rows === 0)).toEqual([]);

      await eraseAccount(
        db,
        clock,
        { userId: world.adaId, sessionId: world.sessionId },
        world.adaUsername,
        chatUserErased(),
      );

      const left: Record<Table, number> = {};
      for (const [table, probe] of Object.entries(seeded))
        left[table] = await probe.rows(db, world);
      const survivors = Object.keys(ERASURE_PROBES).filter((table) => left[table] !== 0);
      expect(survivors).toEqual([]);
      // Left, not left alone: the erasure writes its own line to the trail.
      const removed = Object.keys(KEPT_PROBES).filter(
        (table) => (left[table] ?? 0) < (before[table] ?? 0),
      );
      expect(removed).toEqual([]);
    });
  });

  const sweptOrWindowed = tablesWhere(
    ({ retention }) => retention === 'window' || retention === 'swept',
  );

  const runEachJob = async (db: Transaction): Promise<void> => {
    for (const job of new Set(Object.values(RETENTION_PROBES).map((probe) => probe.job))) {
      await SWEEPS[job](db);
    }
  };

  test('every table decided `window` or `swept` is probed or allow-listed, and the allow-list holds nothing else', () => {
    const unheld = sweptOrWindowed.filter(
      (table) => !(table in RETENTION_PROBES) && !(table in UNSEEDED_RETENTION),
    );
    expect(unheld).toEqual([]);
    const stale = [...Object.keys(RETENTION_PROBES), ...Object.keys(UNSEEDED_RETENTION)].filter(
      (table) => !sweptOrWindowed.includes(table),
    );
    expect(stale).toEqual([]);
    expect(Object.keys(UNSEEDED_RETENTION).filter((table) => table in RETENTION_PROBES)).toEqual(
      [],
    );
  });

  test('the job each table names deletes its rows past their time', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const probe of Object.values(RETENTION_PROBES)) await probe.seed(db, world, EXPIRED);
      const before = await Promise.all(
        Object.entries(RETENTION_PROBES).map(
          async ([table, probe]) => [table, await probe.rows(db, EXPIRED)] as const,
        ),
      );
      expect(before.filter(([, rows]) => rows === 0)).toEqual([]);

      await runEachJob(db);

      const survivors: string[] = [];
      for (const [table, probe] of Object.entries(RETENTION_PROBES)) {
        if ((await probe.rows(db, EXPIRED)) !== 0) survivors.push(`${table} (${probe.job})`);
      }
      expect(survivors).toEqual([]);
    });
  });

  // A sweep that deletes too much is not caught by a row past its time: only a row inside it is. Seeded in a world
  // of its own, because one table (the setup's address link) holds a single row, so it cannot hold both.
  test('the job each table names leaves its rows still inside their time', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const probe of Object.values(RETENTION_PROBES)) await probe.seed(db, world, KEPT);
      const before = await Promise.all(
        Object.entries(RETENTION_PROBES).map(
          async ([table, probe]) => [table, await probe.rows(db, KEPT)] as const,
        ),
      );
      expect(before.filter(([, rows]) => rows !== 1)).toEqual([]);

      await runEachJob(db);

      const swept: string[] = [];
      for (const [table, probe] of Object.entries(RETENTION_PROBES)) {
        if ((await probe.rows(db, KEPT)) !== 1) swept.push(`${table} (${probe.job})`);
      }
      expect(swept).toEqual([]);
    });
  });
});
