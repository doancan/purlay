/** A real browser/API/SQL company journey; only the external DNS and IdP are stand-ins. */
import { writeFileSync } from 'node:fs';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { openClient } from '../ingress/http/client';
import { systemClock } from '../platform/clock';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../platform/config';
import { credentialCipher } from '../platform/crypto';
import { SESSION_COOKIE } from '../platform/cookies';
import { NO_LOG } from '../platform/events';
import { inProcessBackplane } from '../realtime/bus';
import { aSession, aTestAuth } from './signed-in';
import { aRoom } from './rooms';
import { testConfig, testDependencies } from './doubles';
import { anOidcStub, OIDC_STUB_CREDENTIALS } from './oidc-stub';

const argument = (name: string): string => {
  const value = process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes(name) || value === undefined) throw new Error(`Missing ${name}`);
  return value;
};
const port = Number(argument('--port'));
if (!Number.isInteger(port) || port < 1024 || port > 65_534) throw new Error('Invalid port');
const manifest = argument('--manifest');
const origin = `http://localhost:${String(port)}`;
const capability = crypto.randomUUID();
const records = new Map<string, string>();
let clone: ClonedDatabase | undefined;
let app: HttpApplication | undefined;
let external: ReturnType<typeof Bun.serve> | undefined;
let stopping: Promise<void> | undefined;

const stop = async (): Promise<void> => {
  stopping ??= (async (): Promise<void> => {
    // A signal during allocation/seeding waits for that same startup, then cleans only its successful allocation.
    await started.catch(() => undefined);
    try {
      await Promise.all([external?.stop(true), app?.stop(true)]);
    } finally {
      try {
        await clone?.drop();
      } finally {
        await closeIntegrationDatabase();
      }
    }
  })();
  await stopping;
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void stop().then(() => process.exit(0));
  });
}

const start = async (): Promise<void> => {
  clone = await cloneIntegrationDatabase();
  writeFileSync(`${manifest}.allocation`, JSON.stringify({ database: clone.connectionString }), {
    mode: 0o600,
  });
  const room = await aRoom(clone.db, ['browser-owner', 'browser-member']);
  const owner = room.members['browser-owner'];
  if (owner === undefined) throw new Error('Missing browser owner');
  const elsewhere = await aRoom(clone.db, ['elsewhere-owner']);
  await clone.db
    .insertInto('workspace_members')
    .values({ workspace_id: elsewhere.workspaceId, user_id: owner.userId, role: 'member' })
    .execute();
  const workspace = await clone.db
    .selectFrom('workspaces')
    .select('slug')
    .where('id', '=', room.workspaceId)
    .executeTakeFirstOrThrow();
  const session = await aSession(clone.db, systemClock, owner.userId);
  const idp = await anOidcStub({ sub: 'browser-owner-subject', email: 'owner@company.example' });
  const backplane = inProcessBackplane();
  const auth = aTestAuth(clone.db, {
    baseUrl: origin,
    bus: backplane.node(() => undefined, NO_LOG),
    companyIdentity: { cipher: credentialCipher(DEVELOPMENT_ENCRYPTION_KEY), fetch: idp.fetch },
  });
  const dependencies = {
    ...testDependencies({
      database: clone.db,
      auth,
      backplane,
      clock: systemClock,
      config: testConfig({ APP_URL: origin, PORT: port }),
      client: openClient(new URL('../../../web/dist', import.meta.url).pathname),
      companyTxtLookup: (name) =>
        Promise.resolve(records.has(name) ? [[records.get(name) ?? '']] : []),
    }),
  };
  // Exercise the production HTTP limits and workspace-creation policy.
  delete dependencies.rateBudgets;
  delete dependencies.workspaceCreators;
  app = createApp(dependencies);
  app.listen(port);

  external = Bun.serve({
    hostname: '127.0.0.1',
    port: port + 1,
    fetch: async (request): Promise<Response> => {
      if (request.headers.get('authorization') !== `Bearer ${capability}`)
        return new Response(null, { status: 403 });
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/authorize') {
        const granted = idp.authorize(url.searchParams.get('url') ?? '');
        const callback = new URL(granted.redirectUri);
        callback.searchParams.set('code', granted.code);
        callback.searchParams.set('state', granted.state);
        return Response.redirect(callback.toString(), 302);
      }
      if (request.method === 'POST' && url.pathname === '/dns') {
        const record: unknown = await request.json();
        if (
          typeof record !== 'object' ||
          record === null ||
          !('name' in record) ||
          typeof record.name !== 'string' ||
          record.name.length > 512 ||
          !('value' in record) ||
          typeof record.value !== 'string' ||
          record.value.length > 512
        )
          return new Response(null, { status: 400 });
        records.set(record.name, record.value);
        return new Response(null, { status: 204 });
      }
      if (request.method === 'GET' && url.pathname === '/observations')
        return Response.json({ urls: idp.calls.urls, refusals: idp.refusals });
      return new Response(null, { status: 404 });
    },
  });
  writeFileSync(
    manifest,
    JSON.stringify({
      origin,
      external: `http://127.0.0.1:${String(port + 1)}`,
      capability,
      workspaceId: room.workspaceId,
      slug: workspace.slug,
      elsewhereId: elsewhere.workspaceId,
      userId: owner.userId,
      cookie: { name: SESSION_COOKIE, value: session.token },
      oidc: { issuer: idp.issuer(), ...OIDC_STUB_CREDENTIALS },
    }),
    { mode: 0o600 },
  );
};
const started = start();
try {
  await started;
} catch (error) {
  await stop();
  throw error;
}
