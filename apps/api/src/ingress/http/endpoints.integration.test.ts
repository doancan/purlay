/**
 * Every entry of the endpoint table, called against a real server and held to what the table says (D-192).
 *
 * A schema in a table is a claim. A client generated from it is as right as the claim, so the claim is
 * tested the way a client meets it: a real request from a real session against a real database, and the
 * answer — its status and its body — checked against the schema the table names. **A response the table does
 * not describe is a failure.** The same for what a request carries: the body and the query are checked
 * against their schemas *before* they are sent, so a scenario cannot pass with a shape the contract refuses.
 *
 * Every entry has a step here, or is named in `HELD_ELSEWHERE` with the test that holds its answer to the
 * schema — never silently absent: the last test fails on an entry that is neither.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import { cloneIntegrationDatabase, type ClonedDatabase, type Executor } from '@purlay/db';
import { ENDPOINTS, messageId, type EndpointSpec } from '@purlay/types';
import { createApp, type HttpApplication } from './app';
import { fixedClock } from '../../platform/clock';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { testConfig, testDependencies } from '../../testing/doubles';
import { twoColourPng } from '../../testing/png';
import { aMemoryStore } from '../../testing/storage';
import { aUniqueSlug } from '../../testing/users';

const origin = 'https://purlay.test';
const NOW = new Date('2026-10-26T12:00:00.000Z');
const clock = fixedClock(NOW);
let cloned: ClonedDatabase;
let db: Executor;
let app: HttpApplication;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
  app = createApp(
    testDependencies({
      database: db,
      clock,
      storage: aMemoryStore(),
      config: testConfig({ APP_URL: origin }),
    }),
  );
});

afterAll(async () => {
  await cloned.drop();
});

/** What this test does not call, and where the answer is held to its schema instead. */
const HELD_ELSEWHERE: Readonly<
  Record<string, { readonly why: string; readonly file: string; readonly schema: string }>
> = {
  unfurlGitHubLink: {
    why: 'needs a GitHub to answer; the stub and its cases live with the integration',
    file: 'apps/api/src/ingress/http/integrations.integration.test.ts',
    schema: 'UnfurlResponse',
  },
  fetchExternalImage: {
    why: 'fetches a page from another server, which needs the image proxy’s own stand-in',
    file: 'apps/api/src/ingress/http/images.integration.test.ts',
    schema: 'content-type',
  },
};

interface Context {
  alice: SignedInUser;
  bob: SignedInUser;
  /** A second session of Alice's, so signing out has one to end that the other steps do not need. */
  aliceElsewhere: SignedInUser;
  /** The id of a third session of Alice's, which the device list ends. */
  aliceDeviceId: string;
  workspaceId: string;
  channelId: string;
  extraChannelId: string;
  rootId: string;
  replyId: string;
  attachmentId: string;
  throwawayAttachmentId: string;
  nativeCode: string;
}

const ids = new Set<string>();
const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
let tick = 0;
const anId = (): string => messageId(new Date(NOW.getTime() - 30_000 + (tick += 1)));

interface Spec {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly json?: unknown;
  readonly bytes?: Uint8Array;
}

interface Step {
  readonly id: string;
  /** Who calls; `nobody` is a request with no session. */
  readonly as?: 'alice' | 'bob' | 'aliceElsewhere' | 'nobody';
  readonly spec: (c: Context) => Spec;
  readonly status: number;
  readonly then?: (c: Context, body: unknown, response: Response) => void;
}

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const STEPS: readonly Step[] = [
  // ── Before anybody is signed in
  { id: 'getClientInfo', as: 'nobody', spec: () => ({}), status: 200 },
  { id: 'getAuthMethods', as: 'nobody', spec: () => ({}), status: 200 },
  { id: 'getMe', spec: () => ({}), status: 200 },

  // ── Workspaces
  { id: 'listWorkspaces', spec: () => ({}), status: 200 },
  { id: 'getWorkspace', spec: (c) => ({ params: { workspaceId: c.workspaceId } }), status: 200 },
  {
    id: 'listWorkspaceMembers',
    spec: (c) => ({ params: { workspaceId: c.workspaceId } }),
    status: 200,
  },
  { id: 'getPresence', spec: (c) => ({ params: { workspaceId: c.workspaceId } }), status: 200 },
  {
    id: 'setDeepWork',
    spec: (c) => ({
      params: { workspaceId: c.workspaceId },
      json: { active: true, until: new Date(NOW.getTime() + 3_600_000).toISOString() },
    }),
    status: 200,
  },
  {
    id: 'setDeepWork',
    spec: (c) => ({ params: { workspaceId: c.workspaceId }, json: { active: false } }),
    status: 200,
  },

  // ── Channels
  { id: 'listChannels', spec: (c) => ({ params: { workspaceId: c.workspaceId } }), status: 200 },
  {
    id: 'createChannel',
    spec: (c) => ({
      params: { workspaceId: c.workspaceId },
      json: { name: 'extra', topic: 'More' },
    }),
    status: 201,
    then: (c, body): void => {
      c.extraChannelId = String(asRecord(body)['id']);
    },
  },
  { id: 'getChannel', spec: (c) => ({ params: { channelId: c.channelId } }), status: 200 },
  {
    id: 'joinChannel',
    as: 'bob',
    spec: (c) => ({ params: { channelId: c.extraChannelId } }),
    status: 200,
  },
  {
    id: 'leaveChannel',
    as: 'bob',
    spec: (c) => ({ params: { channelId: c.extraChannelId } }),
    status: 204,
  },
  {
    id: 'addChannelMember',
    spec: (c) => ({ params: { channelId: c.extraChannelId }, json: { userId: c.bob.userId } }),
    status: 204,
  },
  { id: 'listChannelMembers', spec: (c) => ({ params: { channelId: c.channelId } }), status: 200 },
  {
    id: 'setNotificationLevel',
    spec: (c) => ({ params: { channelId: c.channelId }, json: { level: 'all' } }),
    status: 204,
  },
  { id: 'starChannel', spec: (c) => ({ params: { channelId: c.channelId } }), status: 204 },
  { id: 'unstarChannel', spec: (c) => ({ params: { channelId: c.channelId } }), status: 204 },
  {
    id: 'openConversation',
    spec: (c) => ({ params: { workspaceId: c.workspaceId }, json: { userIds: [c.bob.userId] } }),
    status: 201,
  },
  {
    id: 'openDirectMessage',
    spec: (c) => ({ params: { workspaceId: c.workspaceId }, json: { userId: c.bob.userId } }),
    status: 200,
  },

  // ── Messages: a root, a reply that mentions Alice, and everything a person does to them
  {
    id: 'sendMessage',
    spec: (c) => ({
      params: { channelId: c.channelId },
      json: { id: anId(), content: 'The deploy is **green** — see `main`' },
    }),
    status: 201,
    then: (c, body): void => {
      c.rootId = String(asRecord(body)['id']);
    },
  },
  {
    id: 'sendMessage',
    as: 'bob',
    spec: (c) => ({
      params: { channelId: c.channelId },
      json: { id: anId(), content: `@${c.alice.username} thanks`, parentId: c.rootId },
    }),
    status: 201,
    then: (c, body): void => {
      c.replyId = String(asRecord(body)['id']);
    },
  },
  {
    id: 'listMessages',
    spec: (c) => ({ params: { channelId: c.channelId }, query: { limit: 10 } }),
    status: 200,
  },
  {
    id: 'listChanges',
    spec: (c) => ({ params: { channelId: c.channelId }, query: { limit: 10 } }),
    status: 200,
  },
  { id: 'getMessagesAround', spec: (c) => ({ params: { messageId: c.rootId } }), status: 200 },
  { id: 'getThread', spec: (c) => ({ params: { messageId: c.rootId } }), status: 200 },
  {
    id: 'editMessage',
    spec: (c) => ({ params: { messageId: c.rootId }, json: { content: 'The deploy is green' } }),
    status: 200,
  },
  { id: 'listMessageVersions', spec: (c) => ({ params: { messageId: c.rootId } }), status: 200 },
  {
    id: 'putReaction',
    as: 'bob',
    spec: (c) => ({ params: { messageId: c.rootId, emoji: '👍' } }),
    status: 200,
  },
  {
    id: 'deleteReaction',
    as: 'bob',
    spec: (c) => ({ params: { messageId: c.rootId, emoji: '👍' } }),
    status: 200,
  },
  { id: 'pinMessage', spec: (c) => ({ params: { messageId: c.rootId } }), status: 204 },
  { id: 'listPins', spec: (c) => ({ params: { channelId: c.channelId } }), status: 200 },
  { id: 'unpinMessage', spec: (c) => ({ params: { messageId: c.rootId } }), status: 204 },
  {
    id: 'saveMessage',
    spec: (c) => ({ params: { messageId: c.rootId }, json: { state: 'in_progress' } }),
    status: 204,
  },
  {
    id: 'listSaved',
    spec: (c) => ({ params: { workspaceId: c.workspaceId }, query: { state: 'in_progress' } }),
    status: 200,
  },
  { id: 'listSavedIds', spec: (c) => ({ params: { workspaceId: c.workspaceId } }), status: 200 },
  { id: 'unsaveMessage', spec: (c) => ({ params: { messageId: c.rootId } }), status: 204 },
  {
    id: 'setKnowledge',
    spec: (c) => ({
      params: { messageId: c.rootId },
      json: {
        version: 0,
        isQuestion: true,
        assigneeId: c.alice.userId,
        acceptedAnswerId: c.replyId,
        decisionNote: 'Keep the deployment window.',
        decisionUrl: 'https://github.com/acme/api/issues/1',
      },
    }),
    status: 200,
  },
  {
    id: 'saveSearch',
    spec: (c) => ({
      params: { workspaceId: c.workspaceId, searchId: c.rootId },
      json: { name: 'Open questions', query: { q: '', question: 'yes', status: 'open' } },
    }),
    status: 200,
  },
  {
    id: 'listSavedSearches',
    spec: (c) => ({ params: { workspaceId: c.workspaceId } }),
    status: 200,
  },
  {
    id: 'deleteSavedSearch',
    spec: (c) => ({ params: { workspaceId: c.workspaceId, searchId: c.rootId } }),
    status: 204,
  },
  { id: 'resolveThread', spec: (c) => ({ params: { messageId: c.rootId } }), status: 200 },
  { id: 'reopenThread', spec: (c) => ({ params: { messageId: c.rootId } }), status: 200 },
  { id: 'getThreadFollow', spec: (c) => ({ params: { messageId: c.rootId } }), status: 200 },
  {
    id: 'setThreadFollow',
    spec: (c) => ({ params: { messageId: c.rootId }, json: { following: true } }),
    status: 200,
  },
  {
    id: 'markThreadRead',
    spec: (c) => ({ params: { messageId: c.rootId }, json: { lastReadMessageId: c.replyId } }),
    status: 204,
  },
  {
    id: 'markChannelRead',
    spec: (c) => ({ params: { channelId: c.channelId }, json: { lastReadMessageId: c.rootId } }),
    status: 200,
  },

  // ── What needs the person
  {
    id: 'listUnresolved',
    spec: (c) => ({ params: { workspaceId: c.workspaceId }, query: {} }),
    status: 200,
  },
  {
    id: 'searchMessages',
    spec: (c) => ({ params: { workspaceId: c.workspaceId }, query: { q: 'deploy' } }),
    status: 200,
  },
  {
    id: 'listNotifications',
    spec: (c) => ({ query: { workspaceId: c.workspaceId } }),
    status: 200,
  },
  {
    id: 'markNotificationsRead',
    spec: (c) => ({ json: { workspaceId: c.workspaceId } }),
    status: 204,
  },

  // ── Files
  {
    id: 'uploadFile',
    spec: (c) => ({
      params: { workspaceId: c.workspaceId },
      query: { id: anId(), name: 'picture.png' },
      bytes: twoColourPng(8, 8),
    }),
    status: 201,
    then: (c, body): void => {
      c.attachmentId = String(asRecord(body)['id']);
    },
  },
  {
    id: 'uploadFile',
    spec: (c) => ({
      params: { workspaceId: c.workspaceId },
      query: { id: anId(), name: 'second.png' },
      bytes: twoColourPng(8, 8, [0, 255, 0], [255, 255, 0]),
    }),
    status: 201,
    then: (c, body): void => {
      c.throwawayAttachmentId = String(asRecord(body)['id']);
    },
  },
  {
    id: 'sendMessage',
    spec: (c) => ({
      params: { channelId: c.channelId },
      json: { id: anId(), content: 'a picture', attachmentIds: [c.attachmentId] },
    }),
    status: 201,
  },
  {
    id: 'listFiles',
    spec: (c) => ({ params: { channelId: c.channelId }, query: {} }),
    status: 200,
  },
  {
    id: 'downloadAttachment',
    spec: (c) => ({ params: { attachmentId: c.attachmentId } }),
    status: 200,
  },
  {
    id: 'downloadAttachmentThumbnail',
    spec: (c) => ({ params: { attachmentId: c.attachmentId } }),
    status: 200,
  },
  {
    id: 'discardAttachment',
    spec: (c) => ({ params: { attachmentId: c.throwawayAttachmentId } }),
    status: 204,
  },

  // ── The native application's way in, and the ends of sessions
  {
    id: 'nativeAuthorize',
    spec: () => ({ json: { challenge, state } }),
    status: 200,
    then: (c, body): void => {
      c.nativeCode = new URL(String(asRecord(body)['redirect'])).searchParams.get('code') ?? '';
    },
  },
  {
    id: 'nativeToken',
    as: 'nobody',
    spec: (c) => ({ json: { code: c.nativeCode, verifier, device: { name: 'A Mac' } } }),
    status: 204,
  },
  { id: 'listMySessions', spec: () => ({}), status: 200 },
  {
    id: 'endMySession',
    spec: (c) => ({ params: { sessionId: c.aliceDeviceId } }),
    status: 204,
  },
  { id: 'logout', as: 'aliceElsewhere', spec: () => ({}), status: 204 },
  { id: 'deleteMessage', spec: (c) => ({ params: { messageId: c.replyId } }), status: 204 },
  { id: 'logoutEverywhere', as: 'bob', spec: () => ({}), status: 204 },
];

const entryOf = (id: string): EndpointSpec => {
  const found = (ENDPOINTS as readonly EndpointSpec[]).find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no endpoint is called ${id}`);
  return found;
};

const spellPath = (path: string, params: Readonly<Record<string, string>> = {}): string =>
  path.replace(/:([A-Za-z]+)/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? `MISSING-${name}`),
  );

const refuse = (schema: TSchema, value: unknown, what: string): void => {
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)][0];
    throw new Error(
      `${what} does not match its schema: ${first?.path ?? ''} ${first?.message ?? ''}`,
    );
  }
};

const world = async (): Promise<Context> => {
  const alice = await aSignedInUser(db, clock, 'alice');
  const bob = await aSignedInUser(db, clock, 'bob');
  const aliceElsewhere = {
    ...alice,
    cookie: (await aSignedInUser(db, clock, 'unused')).cookie,
  };
  // A second session of Alice's own: minted for her user, not another's.
  const { aSession } = await import('../../testing/signed-in');
  const second = await aSession(db, clock, alice.userId);
  aliceElsewhere.cookie = `__Host-purlay_session=${second.token}`;
  const device = await aSession(db, clock, alice.userId, 30, { deviceName: 'A test Mac' });

  const slug = aUniqueSlug('contract');
  const made = await app.handle(
    new Request(`${origin}/api/workspaces`, {
      method: 'POST',
      headers: { cookie: alice.cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: slug, slug }),
    }),
  );
  const workspaceId = String(asRecord(await made.json())['id']);
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW })
    .execute();
  const channel = await db
    .selectFrom('channels')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirstOrThrow();
  await db
    .insertInto('channel_members')
    .values({ channel_id: channel.id, user_id: bob.userId, joined_at: NOW })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
  return {
    alice,
    bob,
    aliceElsewhere,
    aliceDeviceId: device.sessionId,
    workspaceId,
    channelId: channel.id,
    extraChannelId: '',
    rootId: '',
    replyId: '',
    attachmentId: '',
    throwawayAttachmentId: '',
    nativeCode: '',
  };
};

describe('integration: the endpoint table, against a real server', () => {
  let context: Context;
  const exercised = new Set<string>();

  beforeAll(async () => {
    context = await world();
  });

  for (const [index, step] of STEPS.entries()) {
    test(`${String(index + 1).padStart(2, '0')} ${step.id}${step.as === undefined || step.as === 'alice' ? '' : ` (as ${step.as})`}`, async () => {
      ids.add(step.id);
      const entry = entryOf(step.id);
      const spec = step.spec(context);

      // What the request carries is held to the contract before it leaves.
      if (entry.query !== undefined)
        refuse(entry.query, spec.query ?? {}, `the query of ${step.id}`);
      if (entry.body !== undefined && entry.body !== 'octet-stream') {
        refuse(entry.body, spec.json, `the body of ${step.id}`);
      }

      const who = step.as ?? 'alice';
      const headers: Record<string, string> = {};
      if (who !== 'nobody') headers['cookie'] = context[who].cookie;
      let payload: Uint8Array | string | undefined;
      if (entry.method !== 'GET') headers['origin'] = origin;
      if (spec.bytes !== undefined) {
        headers['content-type'] = 'application/octet-stream';
        headers['content-length'] = String(spec.bytes.length);
        payload = spec.bytes;
      } else if (spec.json !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(spec.json);
      }
      const query = new URLSearchParams(
        Object.entries(spec.query ?? {}).map(([name, value]): [string, string] => [
          name,
          String(value),
        ]),
      ).toString();
      const response = await app.handle(
        new Request(
          `${origin}${spellPath(entry.path, spec.params)}${query === '' ? '' : `?${query}`}`,
          {
            method: entry.method,
            headers,
            ...(payload === undefined ? {} : { body: payload }),
          },
        ),
      );

      // The status is one the table names for this entry.
      const declared = Object.keys(entry.responses).map(Number);
      expect({ id: step.id, status: response.status }).toEqual({
        id: step.id,
        status: step.status,
      });
      expect(declared).toContain(response.status);

      // And the body is what the schema says it is.
      const expected = entry.responses[response.status];
      let body: unknown = null;
      if (expected === null) {
        expect(await response.text()).toBe('');
      } else if (expected === 'binary') {
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(bytes.length).toBeGreaterThan(0);
        expect(response.headers.get('content-type')).not.toBeNull();
      } else if (expected !== undefined) {
        body = await response.json();
        refuse(expected, body, `the answer of ${step.id}`);
      }
      step.then?.(context, body, response);
      exercised.add(step.id);
    });
  }

  test('every entry of the table has a step, or is held to its schema by a test it names — never neither', () => {
    const missing = (ENDPOINTS as readonly EndpointSpec[])
      .map((entry) => entry.id)
      .filter((id) => !exercised.has(id) && HELD_ELSEWHERE[id] === undefined);
    expect(missing).toEqual([]);
  });

  test('what is held elsewhere is held there: the named test mentions the schema it holds the answer to', () => {
    for (const [id, held] of Object.entries(HELD_ELSEWHERE)) {
      expect(entryOf(id).id).toBe(id);
      expect({ id, mentioned: readFileSync(held.file, 'utf8').includes(held.schema) }).toEqual({
        id,
        mentioned: true,
      });
    }
  });

  test('every step names an entry, and no entry is held elsewhere while a step also calls it', () => {
    for (const id of ids) expect(entryOf(id).id).toBe(id);
    for (const id of Object.keys(HELD_ELSEWHERE)) expect(exercised.has(id)).toBe(false);
  });
});
