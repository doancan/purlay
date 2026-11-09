/** Server-owned Web Push (#1325): one-time env seed, immutable sealed pair, audited live enable/disable. */
import type { Executor } from '@purlay/db';
import type { ServerPushSettings } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import type { CredentialCipher } from '../../platform/crypto';
import { atomicallyOn } from '../../platform/transactions';
import { lockServerAdministrator } from '../administration/changes';
import { recordServerAudit } from '../audit/server-audit';
import type { ServerAdminSession } from '../setup/setup';
import { generateVapidKeys, type VapidKeys } from './vapid';

const COLUMN = 'server_settings.push_private_key_encrypted';
type Environment = Pick<
  Config,
  'APP_URL' | 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'
>;
export interface PushConfiguration {
  readonly view: () => Promise<ServerPushSettings>;
  readonly keys: () => Promise<VapidKeys | undefined>;
  readonly change: (admin: ServerAdminSession, enabled: boolean) => Promise<ServerPushSettings>;
}

export const pushConfiguration = (
  database: Executor,
  cipher: CredentialCipher,
  clock: Clock,
  environment: Environment,
): PushConfiguration => {
  const sealed = async (keys: VapidKeys): Promise<string> =>
    Buffer.from(await cipher.seal(keys.privateKey, COLUMN)).toString('base64');
  const read = async (): Promise<{
    enabled: boolean;
    publicKey: string | null;
    privateKey: string | null;
    subject: string | null;
  }> => {
    const row = await database
      .selectFrom('server_settings')
      .select([
        'push_enabled as enabled',
        'push_public_key as publicKey',
        'push_private_key_encrypted as privateKey',
        'push_subject as subject',
        'push_imported_from_env_at as imported',
      ])
      .where('id', '=', true)
      .executeTakeFirst();
    if (row !== undefined && row.imported !== null) return row;
    await atomicallyOn(database)(async (tx) => {
      await tx
        .insertInto('server_settings')
        .values({ id: true })
        .onConflict((c) => c.column('id').doNothing())
        .execute();
      const current = await tx
        .selectFrom('server_settings')
        .select('push_imported_from_env_at')
        .where('id', '=', true)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.push_imported_from_env_at !== null) return;
      const {
        VAPID_PUBLIC_KEY: publicKey,
        VAPID_PRIVATE_KEY: privateKey,
        VAPID_SUBJECT: subject,
      } = environment;
      const keys =
        publicKey === undefined || privateKey === undefined || subject === undefined
          ? undefined
          : { publicKey, privateKey, subject };
      await tx
        .updateTable('server_settings')
        .set({
          push_enabled: keys !== undefined,
          push_public_key: keys?.publicKey ?? null,
          push_private_key_encrypted: keys === undefined ? null : await sealed(keys),
          push_subject: keys?.subject ?? null,
          push_imported_from_env_at: clock.now(),
        })
        .where('id', '=', true)
        .execute();
    });
    return await read();
  };
  const view = async (): Promise<ServerPushSettings> => {
    const row = await read();
    return { enabled: row.enabled, keysCreated: row.publicKey !== null, subject: row.subject };
  };
  return {
    view,
    keys: async (): Promise<VapidKeys | undefined> => {
      const row = await read();
      if (!row.enabled || row.publicKey === null || row.privateKey === null || row.subject === null)
        return undefined;
      return {
        publicKey: row.publicKey,
        privateKey: await cipher.open(Buffer.from(row.privateKey, 'base64'), COLUMN),
        subject: row.subject,
      };
    },
    change: async (admin, enabled): Promise<ServerPushSettings> => {
      return await atomicallyOn(database)(async (tx) => {
        await lockServerAdministrator(tx, admin);
        await pushConfiguration(tx, cipher, clock, environment).view();
        const row = await tx
          .selectFrom('server_settings')
          .selectAll()
          .where('id', '=', true)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (enabled && row.push_private_key_encrypted !== null)
          await cipher.open(Buffer.from(row.push_private_key_encrypted, 'base64'), COLUMN);
        if (row.push_enabled !== enabled) {
          const keys =
            enabled && row.push_public_key === null
              ? await generateVapidKeys(environment.APP_URL.replace(/^http:/, 'https:'))
              : undefined;
          await tx
            .updateTable('server_settings')
            .set({
              push_enabled: enabled,
              updated_at: clock.now(),
              ...(keys === undefined
                ? {}
                : {
                    push_public_key: keys.publicKey,
                    push_private_key_encrypted: await sealed(keys),
                    push_subject: keys.subject,
                  }),
            })
            .where('id', '=', true)
            .execute();
          await recordServerAudit(tx, clock, {
            actorUserId: admin.userId,
            action: enabled ? 'server.push_enabled' : 'server.push_disabled',
          });
        }
        return await pushConfiguration(tx, cipher, clock, environment).view();
      });
    },
  };
};
