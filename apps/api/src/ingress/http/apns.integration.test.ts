import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import type { ClientInfo } from '@purlay/types';
import { revokeSession } from '../../modules/auth/sessions';
import { fixedClock } from '../../platform/clock';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSignedInUser } from '../../testing/signed-in';
import { createApp } from './app';

const clock = fixedClock(NOW);
const path = '/api/push/apns/subscriptions';
let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const request = (route: string, body: unknown, cookie?: string): Request =>
  new Request(`https://purlay.test${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });

describe('integration: APNs device routes', () => {
  test('require a session and refuse registration when delivery is off', async () => {
    const app = createApp(testDependencies({ database: cloned.db, clock }));
    const owner = await aSignedInUser(cloned.db, clock, 'apns-http-off');
    const input = { deviceToken: 'aa1000' };
    const capabilities = await app.handle(new Request('https://purlay.test/api/client'));
    expect(
      ((await capabilities.json()) as ClientInfo).capabilities?.apnsNotifications,
    ).toBeUndefined();

    expect((await app.handle(request(path, input))).status).toBe(401);
    expect((await app.handle(request(`${path}/remove`, input))).status).toBe(401);
    expect((await app.handle(request(`${path}/remove`, {}))).status).toBe(401);
    const unavailable = await app.handle(request(path, input, owner.cookie));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: { code: 'PUSH_UNAVAILABLE' } });
    expect(
      await cloned.db
        .selectFrom('apns_subscriptions')
        .where('session_id', '=', owner.sessionId)
        .select('session_id')
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  test('validate, renew and remove only the current session’s device', async () => {
    const dependencies = testDependencies({ database: cloned.db, clock });
    const app = createApp({ ...dependencies, apnsScope: 'sandbox:TESTTEAM00:com.purlay.ios' });
    const off = createApp(dependencies);
    const capabilities = await app.handle(new Request('https://purlay.test/api/client'));
    expect(((await capabilities.json()) as ClientInfo).capabilities?.apnsNotifications).toBe(true);
    const owner = await aSignedInUser(cloned.db, clock, 'apns-http-owner');
    const other = await aSignedInUser(cloned.db, clock, 'apns-http-other');
    const raw = 'aB2000';
    const input = { deviceToken: raw };

    expect((await app.handle(request(path, { deviceToken: 'x!' }, owner.cookie))).status).toBe(400);
    expect(
      (await app.handle(request(path, { ...input, sessionId: other.sessionId }, owner.cookie)))
        .status,
    ).toBe(400);
    expect((await app.handle(request(path, input, owner.cookie))).status).toBe(204);
    expect((await app.handle(request(path, input, owner.cookie))).status).toBe(204);
    const conflict = await app.handle(request(path, input, other.cookie));
    expect(conflict.status).toBe(400);
    expect((await conflict.text()).toLowerCase()).not.toContain(raw.toLowerCase());
    expect((await app.handle(request(`${path}/remove`, input, other.cookie))).status).toBe(204);
    expect((await app.handle(request(path, input, other.cookie))).status).toBe(400);
    expect((await off.handle(request(`${path}/remove`, {}, other.cookie))).status).toBe(204);
    expect((await app.handle(request(path, input, other.cookie))).status).toBe(400);
    expect((await off.handle(request(`${path}/remove`, {}, owner.cookie))).status).toBe(204);
    expect((await app.handle(request(path, input, other.cookie))).status).toBe(204);

    await revokeSession(cloned.db, other.sessionId);
    expect((await app.handle(request(path, input, other.cookie))).status).toBe(401);
    expect((await app.handle(request(path, input, owner.cookie))).status).toBe(204);
    expect(
      (await off.handle(request(`${path}/remove`, { deviceToken: '0000' }, owner.cookie))).status,
    ).toBe(204);
    const registered = () =>
      cloned.db
        .selectFrom('apns_subscriptions')
        .where('session_id', '=', owner.sessionId)
        .select('session_id')
        .executeTakeFirst();
    expect(await registered()).toBeDefined();
    expect((await off.handle(request(`${path}/remove`, input, owner.cookie))).status).toBe(204);
    expect(await registered()).toBeUndefined();
  });
});
