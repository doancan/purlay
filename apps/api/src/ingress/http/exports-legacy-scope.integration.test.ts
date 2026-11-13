/** A legacy tar cannot rediscover its old workspace scope from a corpus that retention already removed.
 * @needs-modules chat
 */
import { describe, afterAll, beforeAll, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { exportCatalogue, personalExportCatalogue } from '../../export-catalogue';
import { sendMessage } from '../../features/chat/messages/messages';
import { exportQueue } from '../../modules/export/queue';
import { SESSION_COOKIE } from '../../platform/cookies';
import { createLogger, withoutRequest } from '../../platform/logging';
import { aMovableClock, testDependencies } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { aSession, aTestAuth } from '../../testing/signed-in';
import { aMemoryStore } from '../../testing/storage';
import type { ObjectStore } from '../../platform/storage';
import { aUniqueSlug } from '../../testing/users';
import { createApp } from './app';

describe('integration: legacy archive scope', () => {
  const stages = ['before-request', 'during-storage', 'during-stream'] as const;
  const owned = new Map<(typeof stages)[number], ClonedDatabase>();
  beforeAll(async () => {
    for (const stage of stages) owned.set(stage, await cloneIntegrationDatabase());
  }, CLONE_HOOK_MS);
  afterAll(async () => {
    await Promise.all(
      [...owned.values()].map(async (database): Promise<void> => {
        await database.drop();
      }),
    );
  }, DROP_HOOK_MS);

  test.each(stages)(
    'a legacy NULL-scope archive cannot lose its governed history (%s)',
    async (stage) => {
      const database = owned.get(stage)?.db;
      if (database === undefined) throw new Error('Missing legacy archive database');
      const clock = aMovableClock(new Date());
      const room = await aRoom(database, ['legacy-archive-author', 'legacy-archive-owner']);
      const author = room.members['legacy-archive-author'];
      const owner = room.members['legacy-archive-owner'];
      if (author === undefined || owner === undefined)
        throw new Error('Missing legacy archive actors');
      const marker = 'legacy archived workspace words';
      const id = messageId(clock.now());
      await sendMessage(database, clock, author.context, { id, content: marker });
      const session = await aSession(database, clock, author.userId);
      const backing = aMemoryStore();
      let onDownload: ObjectStore['get'] | undefined;
      const storage: ObjectStore = {
        ...backing,
        get: (key) => onDownload?.(key) ?? backing.get(key),
      };
      const queue = exportQueue({
        database,
        clock,
        storage,
        catalogue: exportCatalogue,
        personalCatalogue: personalExportCatalogue,
        log: createLogger({ level: 'silent' }),
      });
      const app = createApp(
        testDependencies({
          database,
          auth: aTestAuth(database),
          clock,
          storage,
          personalExportRunner: queue.startPersonal,
        }),
      );
      const call = async (path: string, method = 'GET'): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test${path}`, {
            method,
            headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
          }),
        );
      const asked = await call('/api/me/exports', 'POST');
      expect(asked.status).toBe(202);
      const result: unknown = await asked.json();
      if (
        typeof result !== 'object' ||
        result === null ||
        !('id' in result) ||
        typeof result.id !== 'string'
      )
        throw new Error('Missing legacy export ID');
      const legacyExportId = result.id;
      await queue.settled();
      const archive = await database
        .selectFrom('personal_exports')
        .select(['status', 'source_workspace_ids', 'storage_key'])
        .where('id', '=', legacyExportId)
        .executeTakeFirstOrThrow();
      expect(archive.status).toBe('ready');
      expect(archive.source_workspace_ids).toEqual([room.workspaceId]);
      if (archive.storage_key === null) throw new Error('Missing actual legacy tar');
      const prepared = await storage.get(archive.storage_key);
      if (prepared === null) throw new Error('Missing prepared legacy bytes');
      expect(await new Response(prepared.body).text()).toContain(marker);
      await withoutRequest(async () => {
        await database
          .updateTable('personal_exports')
          .set({ source_workspace_ids: null })
          .where('id', '=', legacyExportId)
          .execute();
        await database.deleteFrom('messages').where('id', '=', id).execute();
        await database.deleteFrom('channel_members').where('user_id', '=', author.userId).execute();
        await database
          .updateTable('workspace_members')
          .set({ role: 'owner' })
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', owner.userId)
          .execute();
        await database
          .deleteFrom('workspace_members')
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', author.userId)
          .execute();
        const absent = await personalExportCatalogue.absent(database);
        const potential = personalExportCatalogue.workspaces(author.userId, absent);
        expect(
          await database
            .selectFrom('workspaces')
            .select('id')
            .where(sql<boolean>`id in (${potential})`)
            .execute(),
        ).toEqual([]);
      });
      const enforce = async (): Promise<void> => {
        await database
          .updateTable('workspaces')
          .set({ access_policy_epoch: '1' })
          .where('id', '=', room.workspaceId)
          .execute();
        await database
          .insertInto('workspace_access_policies')
          .values({
            workspace_id: room.workspaceId,
            epoch: '1',
            mode: 'enforced',
            sign_in: 'any',
            require_mfa: true,
          })
          .execute();
      };
      const firstDelivered = Promise.withResolvers<undefined>();
      let firstSize = 0;
      if (stage === 'before-request') await enforce();
      else
        onDownload = async (key): ReturnType<ObjectStore['get']> => {
          const stored = await backing.get(key);
          if (stored === null) return null;
          if (stage === 'during-storage') {
            await enforce();
            return stored;
          }
          const bytes = new Uint8Array(await new Response(stored.body).arrayBuffer());
          firstSize = Math.floor(bytes.length / 2);
          let part = 0;
          const body = new ReadableStream<Uint8Array>(
            {
              pull: async (controller): Promise<void> => {
                if (part === 0) {
                  controller.enqueue(bytes.slice(0, firstSize));
                  part += 1;
                  return;
                }
                await firstDelivered.promise;
                await enforce();
                controller.enqueue(bytes.slice(firstSize));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          );
          return { body, size: stored.size };
        };
      const response = await call(`/api/me/exports/${legacyExportId}/download`);
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error('Missing archive response');
      const chunks: Uint8Array[] = [];
      let failed = false;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          const value: unknown = part.value;
          if (!(value instanceof Uint8Array)) throw new Error('Unexpected archive stream value');
          chunks.push(value);
          firstDelivered.resolve(undefined);
        }
      } catch {
        failed = true;
      }
      const bytes = Buffer.concat(chunks);
      const text = bytes.toString();
      console.log(
        JSON.stringify({
          legacyArchiveScope: {
            stage,
            status: response.status,
            bodyFailed: failed,
            receivedBytes: bytes.length,
          },
        }),
      );
      if (stage === 'during-stream') {
        expect(response.status).toBe(200);
        expect(failed).toBe(true);
        expect(bytes.length).toBe(firstSize);
        expect(firstSize).toBeGreaterThan(0);
      } else {
        expect(response.status).toBe(404);
        expect(JSON.parse(text)).toMatchObject({ error: { code: 'EXPORT_NOT_FOUND' } });
        expect(text).not.toContain('workspaceId');
        expect(text).not.toContain(room.workspaceId);
        expect(text).not.toContain(marker);
        if (stage === 'before-request') {
          expect(
            (
              await database
                .selectFrom('personal_exports')
                .select('status')
                .where('id', '=', legacyExportId)
                .executeTakeFirstOrThrow()
            ).status,
          ).toBe('ready');
          const b = await database
            .insertInto('workspaces')
            .values({ name: 'Current B', slug: aUniqueSlug('legacy-control-b') })
            .returning('id')
            .executeTakeFirstOrThrow();
          await database
            .insertInto('workspace_members')
            .values({ workspace_id: b.id, user_id: author.userId, role: 'owner' })
            .execute();
          for (const included of [[b.id], []]) {
            const exportId = messageId(clock.now());
            const key = `exact-control/${exportId}.tar`;
            const safe = new TextEncoder().encode('current exact archive without A');
            await backing.put(key, safe, 'application/x-tar');
            await database
              .insertInto('personal_exports')
              .values({
                id: exportId,
                user_id: author.userId,
                status: 'ready',
                source_session_id: session.sessionId,
                source_workspace_ids: included,
                storage_key: key,
                size_bytes: safe.length,
                created_at: clock.now(),
                finished_at: clock.now(),
                expires_at: new Date(clock.now().getTime() + 3_600_000),
              })
              .execute();
            const allowed = await call(`/api/me/exports/${exportId}/download`);
            expect(allowed.status).toBe(200);
            expect(await allowed.text()).toBe('current exact archive without A');
          }
        }
      }
      await app.settled();
    },
  );
});
