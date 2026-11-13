/** Native adapter selection is limited to the exact live transaction callback. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { runWithAdapter } from '@better-auth/core/context';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { systemClock } from '../../platform/clock';
import { aSession, aTestAuth } from '../../testing/signed-in';
import { aUserRow } from '../../testing/users';
import { nativeAuthenticationEvidence } from './authentication-evidence-native';
import { rememberingTransactions } from './sign-up-transaction';

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const nativeBridge = async (): Promise<{
  readonly native: ReturnType<typeof betterAuth>;
  readonly capture: ReturnType<typeof nativeAuthenticationEvidence>;
}> => {
  // A fresh actual native instance retains all production adapter/schema settings. These controls
  // exercise its adapter transaction contract, so no credential endpoint or fabricated proof is used.
  const native = betterAuth(aTestAuth(clone.db).options);
  const capture = nativeAuthenticationEvidence({
    database: clone.db,
    clock: systemClock,
    instance: native,
    round: () => undefined,
    verifiedMethod: () => undefined,
  });
  await capture.around('/get-session', () => Promise.resolve(new Response(null)));
  return { native, capture };
};

describe('integration: native authentication transaction boundary', () => {
  test('admission uses no native connection and post-transaction work sees the released executor', async () => {
    const { capture } = await nativeBridge();
    let refunded = false;
    await capture.around('/sign-in/email', async () => {
      // Committed admission/counter work must run before any native SQL callback occupies the pool.
      expect(capture.executor()).toBeUndefined();
      await clone.db.selectNoFrom((expression) => expression.val(1).as('probe')).execute();
      await capture.prepareMfa('/get-session', undefined, undefined, () => Promise.resolve(null));
      expect(capture.executor()).toBeDefined();
      await capture.afterTransaction(async () => {
        expect(capture.executor()).toBeUndefined();
        await clone.db.selectNoFrom((expression) => expression.val(1).as('probe')).execute();
        refunded = true;
      });
      expect(refunded).toBe(false);
      return new Response(null);
    });
    expect(refunded).toBe(true);
  });

  test('direct native writes join a failed callback, while global sign-out outside it still deletes every native session', async () => {
    const user = await aUserRow(clone.db, 'native-bridge-owner');
    const { native, capture } = await nativeBridge();
    const context = await native.$context;
    const write = async (): Promise<void> => {
      await context.adapter.update({
        model: 'user',
        where: [{ field: 'id', value: user.userId }],
        update: { name: 'must roll back' },
      });
    };
    const response = await capture.around(
      '/two-factor/verify-totp',
      async () =>
        await runWithAdapter(context.adapter, async () => {
          await capture.prepareMfa('/get-session', undefined, undefined, () =>
            Promise.resolve(null),
          );
          await write();
          return new Response(null, { status: 500 });
        }),
    );
    expect(response.status).toBe(500);
    expect(
      (
        await clone.db
          .selectFrom('users')
          .select('display_name')
          .where('id', '=', user.userId)
          .executeTakeFirstOrThrow()
      ).display_name,
    ).toBe('native-bridge-owner');
    await aSession(clone.db, systemClock, user.userId);
    await aSession(clone.db, systemClock, user.userId);
    await context.internalAdapter.deleteUserSessions(user.userId);
    expect(
      await clone.db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', user.userId)
        .execute(),
    ).toEqual([]);
  });

  test('a delayed child uses restored ordinary native semantics after the marked callback has completed', async () => {
    const user = await aUserRow(clone.db, 'native-delayed-child');
    await aSession(clone.db, systemClock, user.userId);
    await aSession(clone.db, systemClock, user.userId);
    const { native, capture } = await nativeBridge();
    const context = await native.$context;
    const gate = Promise.withResolvers<undefined>();
    let child: Promise<void> | undefined;
    await capture.around(
      '/two-factor/verify-totp',
      async () =>
        await runWithAdapter(context.adapter, async () => {
          await capture.prepareMfa('/get-session', undefined, undefined, () =>
            Promise.resolve(null),
          );
          child = (async (): Promise<void> => {
            await gate.promise;
            await context.internalAdapter.deleteUserSessions(user.userId);
          })();
          return new Response(null);
        }),
    );
    expect(
      await clone.db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', user.userId)
        .execute(),
    ).toHaveLength(2);
    gate.resolve(undefined);
    await child;
    expect(
      await clone.db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', user.userId)
        .execute(),
    ).toEqual([]);
  });

  test('a different held SQL executor cannot inherit the original native adapter transaction', async () => {
    const user = await aUserRow(clone.db, 'native-other-executor');
    const { native, capture } = await nativeBridge();
    const context = await native.$context;
    await capture.around('/two-factor/verify-totp', async () => {
      await capture.prepareMfa('/get-session', undefined, undefined, () => Promise.resolve(null));
      await rememberingTransactions(clone.db)
        .transaction()
        .execute(async () => {
          await context.adapter.update({
            model: 'user',
            where: [{ field: 'id', value: user.userId }],
            update: { name: 'ordinary update survives' },
          });
        });
      return new Response(null, { status: 500 });
    });
    expect(
      (
        await clone.db
          .selectFrom('users')
          .select('display_name')
          .where('id', '=', user.userId)
          .executeTakeFirstOrThrow()
      ).display_name,
    ).toBe('ordinary update survives');
  });
});
