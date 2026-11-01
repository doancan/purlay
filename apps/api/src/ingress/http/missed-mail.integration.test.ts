/**
 * Email about what a person missed (D-240) through real requests: the caller's own setting, offered only where
 * the server has a relay and the address was verified; and the stop link's route, public, which turns the
 * setting off for the person the letter went to and answers one `404` for every link that does not open.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import type { MissedMailSetting } from '@purlay/types';
import { createApp } from './app';
import { aRecordingOutbox, NOW, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { randomToken, tokenDigest } from '../../platform/tokens';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const caller =
  (db: Executor, relay: boolean) =>
  async (
    method: string,
    path: string,
    as: SignedInUser | null,
    body?: unknown,
  ): Promise<Response> =>
    await createApp(
      testDependencies({
        database: db,
        clock: fixedClock(NOW),
        ...(relay ? { mail: aRecordingOutbox() } : {}),
      }),
    ).handle(
      new Request(`https://purlay.test${path}`, {
        method,
        headers: {
          origin: 'https://purlay.test',
          ...(as === null ? {} : { cookie: as.cookie }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

const verified = async (db: Executor, person: SignedInUser): Promise<void> => {
  await db
    .updateTable('users')
    .set({ email_verified: true })
    .where('id', '=', person.userId)
    .execute();
};

describe('integration: GET and PUT /api/me/missed-mail', () => {
  test('off at first; turned on and off; said back as it is kept', async () => {
    await withRollback(async (db) => {
      const call = caller(db, true);
      const ada = await aSignedInUser(db, fixedClock(NOW), 'mm-ada');
      await verified(db, ada);
      const read = async (): Promise<MissedMailSetting> =>
        (await (await call('GET', '/api/me/missed-mail', ada)).json()) as MissedMailSetting;
      expect(await read()).toEqual({ on: false, available: true });
      const on = await call('PUT', '/api/me/missed-mail', ada, { on: true });
      expect(on.status).toBe(200);
      expect(await on.json()).toEqual({ on: true, available: true });
      expect(await read()).toEqual({ on: true, available: true });
      expect((await call('PUT', '/api/me/missed-mail', ada, { on: false })).status).toBe(200);
      expect(await read()).toEqual({ on: false, available: true });
    });
  });

  test('without a relay, or with an address never verified, it is not offered and on is refused by name', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, fixedClock(NOW), 'mm-norelay');
      await verified(db, ada);
      const noRelay = caller(db, false);
      expect(await (await noRelay('GET', '/api/me/missed-mail', ada)).json()).toEqual({
        on: false,
        available: false,
      });
      const refused = await noRelay('PUT', '/api/me/missed-mail', ada, { on: true });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: {
          code: 'VALIDATION_FAILED',
          details: { fields: { on: 'needs a mail server and a verified address' } },
        },
      });
      // Off is never refused.
      expect((await noRelay('PUT', '/api/me/missed-mail', ada, { on: false })).status).toBe(200);

      const unverified = await aSignedInUser(db, fixedClock(NOW), 'mm-unverified');
      const withRelay = caller(db, true);
      expect(await (await withRelay('GET', '/api/me/missed-mail', unverified)).json()).toEqual({
        on: false,
        available: false,
      });
      expect((await withRelay('PUT', '/api/me/missed-mail', unverified, { on: true })).status).toBe(
        400,
      );
    });
  });

  test('signed out is 401; a body that is not the contract is 400', async () => {
    await withRollback(async (db) => {
      const call = caller(db, true);
      const ada = await aSignedInUser(db, fixedClock(NOW), 'mm-shape');
      expect((await call('GET', '/api/me/missed-mail', null)).status).toBe(401);
      expect((await call('PUT', '/api/me/missed-mail', null, { on: true })).status).toBe(401);
      for (const body of [{}, { on: 'yes' }, { on: true, extra: 1 }]) {
        expect((await call('PUT', '/api/me/missed-mail', ada, body)).status).toBe(400);
      }
    });
  });
});

describe('integration: POST /api/missed-mail/stop', () => {
  test('without a session, turns it off for the person the letter went to; again is the same; unknown is 404', async () => {
    await withRollback(async (db) => {
      const call = caller(db, true);
      const ada = await aSignedInUser(db, fixedClock(NOW), 'mm-stop');
      const bob = await aSignedInUser(db, fixedClock(NOW), 'mm-other');
      for (const person of [ada, bob]) {
        await db
          .updateTable('users')
          .set({ email_verified: true, missed_mail_since: NOW })
          .where('id', '=', person.userId)
          .execute();
      }
      const token = randomToken();
      await db
        .insertInto('missed_mail_letters')
        .values({ user_id: ada.userId, sent_at: NOW, stop_digest: await tokenDigest(token) })
        .execute();

      const unknown = await call('POST', '/api/missed-mail/stop', null, { token: randomToken() });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ error: { code: 'MAIL_LINK_NOT_FOUND' } });
      for (const body of [{}, { token: 'short' }, { token: token.toUpperCase() }]) {
        expect((await call('POST', '/api/missed-mail/stop', null, body)).status).toBe(400);
      }

      // Opened in Bob's browser: it is still Ada's letter, and Ada's setting.
      expect((await call('POST', '/api/missed-mail/stop', bob, { token })).status).toBe(204);
      expect((await call('POST', '/api/missed-mail/stop', null, { token })).status).toBe(204);
      expect(await (await call('GET', '/api/me/missed-mail', ada)).json()).toEqual({
        on: false,
        available: true,
      });
      expect(await (await call('GET', '/api/me/missed-mail', bob)).json()).toEqual({
        on: true,
        available: true,
      });
    });
  });
});
