/** Configured directory references must not trap the actual committed workspace purge forever. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { WORKSPACE_DELETION_GRACE_DAYS } from '@purlay/types';
import { DAY_MS, fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aRecordingLogger } from '../../testing/doubles';
import { PUSH_QUIET_BUS } from '../../testing/pending-push';
import { aSession } from '../../testing/signed-in';
import { aMemoryStore } from '../../testing/storage';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { NO_SESSION_LIFETIME } from '../auth/session-lifetime';
import { noWorkspaceChannels } from './channels-port';
import { purgeWorkspaces, type WorkspacePurge } from './deletion-purge';
import { createWorkspaceDirectory } from './directory/service';

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
const asked = new Date('2026-11-12T12:00:00Z');
const clock = fixedClock(asked);
const coreOnly: WorkspacePurge = { before: [], after: [], tables: [] };

describe('integration: configured directory workspace purge', () => {
  test('purges native connection backreferences and scoped directory state, is repeatable, and preserves B and global authority', async () => {
    const db = clone.db;
    const user = await aUserRow(db, 'directory-purge-owner');
    const session = await aSession(db, clock, user.userId);
    const originalGlobalSession = await db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', session.sessionId)
      .executeTakeFirstOrThrow();
    const originalUser = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', user.userId)
      .executeTakeFirstOrThrow();
    const sharedSubject = await db
      .insertInto('workspace_directory_scim_subjects')
      .values({
        user_id: user.userId,
        profile_source_id: null,
        revision: 1,
        created_at: asked,
        updated_at: asked,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const configured = [];
    for (const label of ['purged', 'preserved']) {
      const workspace = await db
        .insertInto('workspaces')
        .values({ name: label, slug: aUniqueSlug(`directory-${label}`) })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: workspace.id,
          user_id: user.userId,
          role: 'owner',
          joined_at: asked,
        })
        .execute();
      const domain = await db
        .insertInto('workspace_identity_domains')
        .values({
          workspace_id: workspace.id,
          domain: `${crypto.randomUUID()}.test.invalid`,
          challenge_issued_at: asked,
          challenge_expires_at: new Date(asked.getTime() + DAY_MS),
          verified_at: asked,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const connection = await db
        .insertInto('workspace_identity_connections')
        .values({
          workspace_id: workspace.id,
          domain_id: domain.id,
          name: label,
          issuer: `https://${crypto.randomUUID()}.test.invalid`,
          client_id: 'directory-purge-fixture',
          client_secret_encrypted: Buffer.from('opaque-encrypted-fixture'),
          created_at: asked,
          updated_at: asked,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const actor = {
        context: await requireWorkspaceMembership(db, user.userId, workspace.id),
        sessionId: session.sessionId,
      };
      const directory = await createWorkspaceDirectory(
        {
          database: db,
          clock,
          lifetime: () => NO_SESSION_LIFETIME,
          channels: noWorkspaceChannels,
          readersReady: () => Promise.resolve(true),
          bus: PUSH_QUIET_BUS,
          baseUrl: 'https://purlay.test',
        },
        actor,
        {
          name: `${label} directory`,
          connectionId: connection.id,
          claim: 'sub',
          allowCreate: true,
        },
      );
      expect(
        await db
          .selectFrom('workspace_identity_connections')
          .select('directory_id')
          .where('id', '=', connection.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ directory_id: directory.id });
      const link = await db
        .insertInto('workspace_directory_identity_links')
        .values({
          workspace_id: workspace.id,
          directory_id: directory.id,
          user_id: user.userId,
          external_id: user.userId,
          origin: 'directory_created',
          created_at: asked,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const resource = await db
        .insertInto('workspace_directory_scim_users')
        .values({
          connection_id: directory.id,
          provisioning_domain_id: workspace.id,
          user_id: user.userId,
          connection_user_key: crypto.randomUUID(),
          user_name: user.email,
          user_name_key: crypto.randomUUID(),
          primary_email: user.email,
          work_email_value_index: user.email,
          email_value_index: user.email,
          display_name: label,
          formatted_name: label,
          given_name: null,
          family_name: null,
          serialized_emails: '[]',
          serialized_attributes: null,
          external_id: user.userId,
          external_id_key: crypto.randomUUID(),
          active: true,
          order_key: crypto.randomUUID(),
          created_at: asked,
          updated_at: asked,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      configured.push({
        workspaceId: workspace.id,
        connectionId: connection.id,
        directoryId: directory.id,
        link,
        resource,
      });
    }
    const doomed = configured[0];
    const control = configured[1];
    if (doomed === undefined || control === undefined)
      throw new Error('Missing configured directory controls.');
    const controlConnection = await db
      .selectFrom('workspace_identity_connections')
      .selectAll()
      .where('id', '=', control.connectionId)
      .executeTakeFirstOrThrow();
    const controlDirectory = await db
      .selectFrom('workspace_directories')
      .selectAll()
      .where('id', '=', control.directoryId)
      .executeTakeFirstOrThrow();
    const controlMembership = await db
      .selectFrom('workspace_members')
      .selectAll()
      .where('workspace_id', '=', control.workspaceId)
      .where('user_id', '=', user.userId)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('workspaces')
      .set({ deleted_at: asked })
      .where('id', '=', doomed.workspaceId)
      .execute();
    const due = new Date(asked.getTime() + WORKSPACE_DELETION_GRACE_DAYS * DAY_MS);
    const dependencies = {
      database: db,
      clock: fixedClock(due),
      log: aRecordingLogger().log,
      storage: aMemoryStore(),
    };
    expect(await purgeWorkspaces(dependencies, coreOnly)).toEqual({
      workspaces: 1,
      messages: 0,
      files: 0,
      leftBehind: 0,
    });
    expect(
      await db
        .selectFrom('workspaces')
        .select(['purged_at', 'purge_started_at'])
        .where('id', '=', doomed.workspaceId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ purged_at: due, purge_started_at: due });
    expect(
      await db
        .selectFrom('workspace_identity_connections')
        .select('id')
        .where('id', '=', doomed.connectionId)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom('workspace_directories')
        .select('id')
        .where('id', '=', doomed.directoryId)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom('workspace_directory_identity_links')
        .select('id')
        .where('workspace_id', '=', doomed.workspaceId)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom('workspace_directory_scim_users')
        .select('id')
        .where('connection_id', '=', doomed.directoryId)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom('workspace_members')
        .select('id')
        .where('workspace_id', '=', doomed.workspaceId)
        .execute(),
    ).toEqual([]);
    expect(await purgeWorkspaces(dependencies, coreOnly)).toEqual({
      workspaces: 0,
      messages: 0,
      files: 0,
      leftBehind: 0,
    });
    expect(
      await db
        .selectFrom('server_audit_log')
        .select('id')
        .where('target_workspace_id', '=', doomed.workspaceId)
        .where('action', '=', 'server.workspace_purged')
        .execute(),
    ).toHaveLength(1);
    expect(
      await db
        .selectFrom('workspace_identity_connections')
        .selectAll()
        .where('id', '=', control.connectionId)
        .executeTakeFirstOrThrow(),
    ).toEqual(controlConnection);
    expect(
      await db
        .selectFrom('workspace_directories')
        .selectAll()
        .where('id', '=', control.directoryId)
        .executeTakeFirstOrThrow(),
    ).toEqual(controlDirectory);
    expect(
      await db
        .selectFrom('workspace_directory_identity_links')
        .selectAll()
        .where('id', '=', control.link.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(control.link);
    expect(
      await db
        .selectFrom('workspace_directory_scim_users')
        .selectAll()
        .where('id', '=', control.resource.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(control.resource);
    expect(
      await db
        .selectFrom('workspace_members')
        .selectAll()
        .where('id', '=', controlMembership.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(controlMembership);
    expect(
      await db
        .selectFrom('workspace_directory_scim_subjects')
        .selectAll()
        .where('id', '=', sharedSubject.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(sharedSubject);
    expect(
      await db
        .selectFrom('sessions')
        .selectAll()
        .where('id', '=', session.sessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual(originalGlobalSession);
    expect(
      await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', user.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual(originalUser);
  });
});
