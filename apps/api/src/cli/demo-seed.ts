/**
 * Builds the demo workspace **through the real application**.
 *
 * The seed does not insert messages into tables. It signs in four people (a session
 * issued by the real `issueSession`, so the cookie is genuine), then drives an
 * in-process `createApp` with real `Request`s: create the workspace, create and join
 * channels, send every message to `POST /api/channels/:id/messages`, react, resolve,
 * read. So what the screens show is what the send transaction produced — thread
 * counters, mentions, notifications, unread counters (D-99) — and the seed doubles as a
 * smoke test of the API against a plausible, not a minimal, history.
 *
 * **Why in-process and not against a server.** Two reasons. A message id is a UUIDv7
 * the server accepts only within a minute of its own clock (D-33), and a believable
 * history spans two days: the seed has to *be* the server's clock, which a running
 * process would not let it be. And it needs no port, no ordering of startup, nothing to
 * leave running — the same code runs from the demo harness, from a test inside a
 * rolled-back transaction, and from a developer's shell.
 *
 * What it writes directly, and why: the four users and their workspace memberships
 * (invitations are not built, and sign-in is GitHub's), and the one private channel
 * (no endpoint creates one yet). Everything else is the API's.
 *
 * **Three outsiders** are in no workspace and have two sessions each. They are for the browser
 * tests that end every session a person holds, make workspaces of their own, or erase their account
 * (gwen, D-139 §5): done as one of the four, any would pull the ground from under every other test
 * of the run (D-124).
 */
import { nobodyActive } from '../platform/attention';
import { isTransaction, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { DEVELOPMENT_ENCRYPTION_KEY, type Config } from '../platform/config';
import type { Clock } from '../platform/clock';
import { SESSION_COOKIE } from '../platform/cookies';
import { createLogger } from '../platform/logging';
import { createApp } from '../ingress/http/app';
import { issueSession } from '../modules/auth/sessions';
import { inProcessEventBus } from '../realtime/bus';
import { createAuth, deriveAuthSecret } from '../modules/auth/better-auth';

import {
  PERSONAS,
  apiChannel,
  deploysChannel,
  directMessages,
  incidentsChannel,
  messageCount,
  securityChannel,
  selfNotes,
  type PersonaKey,
  type Step,
} from './demo-script';
import { storeFor } from '../platform/storage';

interface Persona {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  /** The `Cookie` header value a signed-in browser sends, and the bare token under it. */
  readonly cookie: string;
  readonly token: string;
}

/** Somebody in no workspace, signed in twice — two browsers, two sessions. */
interface Outsider {
  readonly userId: string;
  readonly username: string;
  readonly tokens: readonly [string, string];
}

/** The outsiders, by name, and their GitHub ids — past the four people's. */
const OUTSIDERS = { erin: 9_000_101, frank: 9_000_102, gwen: 9_000_103 } as const;
type OutsiderKey = keyof typeof OUTSIDERS;

export interface Manifest {
  readonly workspace: { readonly id: string; readonly slug: string; readonly name: string };
  readonly personas: Readonly<Record<PersonaKey, Persona>>;
  readonly outsiders: Readonly<Record<OutsiderKey, Outsider>>;
  readonly channels: {
    readonly api: string;
    readonly deploys: string;
    readonly incidents: string;
    readonly design: string;
    readonly security: string;
    /** The viewer's direct message with Alice, and with themselves. */
    readonly dmAlice: string;
    readonly dmSelf: string;
  };
  /** Ids of the messages a step named with a `key`, for tests that need to find one. */
  readonly messages: Readonly<Record<string, string>>;
  readonly counts: { readonly messages: number };
}

export interface SeedOptions {
  readonly database: Executor;
  readonly config: Config;
  /** The instant the seeded history ends; it begins about two days before. */
  readonly now: Date;
}

const MINUTE = 60_000;
const SESSION_DAYS = 30;
const SLUG = 'acme-eng';
const WORKSPACE_NAME = 'acme-eng';

/** How long a step list runs, from its first message to its last. */
const durationMinutes = (steps: readonly Step[]): number =>
  steps.reduce(
    (total, step) =>
      total +
      step.gapMinutes +
      (step.replies ?? []).reduce((sum, reply) => sum + reply.gapMinutes, 0),
    0,
  );

const ROOMY = { perSecond: 100_000, burst: 1_000_000 } as const;

/**
 * The only databases the seed will write to: the ones `scripts/demo.ts` and the browser tests
 * create and drop themselves. The seed makes people with 30-day sessions and writes their
 * cookies to a file — pointed at a real database by a mistyped `DATABASE_URL` it would be a
 * backdoor with a receipt, so the name is checked, not the intention (H-API 9).
 */
const DEMO_DATABASE = /^purlay_(?:demo|e2e)(?:[\w-]*)$/;

export const assertDemoDatabase = (connectionString: string): void => {
  const name = new URL(connectionString).pathname.slice(1);
  if (!DEMO_DATABASE.test(name)) {
    throw new Error(
      `refusing to seed "${name}": the demo only writes to a database named purlay_demo… or purlay_e2e…`,
    );
  }
};

/**
 * The secret a scratch server signs sessions with. Its key is always the development key
 * (`scripts/demo.ts`, `testing/fresh-server.ts`), so a session made for it is signed with that key's
 * secret — **never with whatever `ENCRYPTION_KEY` this process happens to hold**: a machine with a `.env`
 * names its own, and a session signed with it is refused by the scratch server, every time, as a plain 401.
 */
export const demoSecret = (): string => deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY);

/**
 * A new session for a person the seed made, in a scratch database only. Signing out everywhere ends
 * every session a person holds, so a browser test of it would leave the seeded ones dead for a retry
 * or a second run against the same server; it asks for a session of its own instead.
 */
export const freshSession = async (
  database: Executor,
  clock: Clock,
  connectionString: string,
  username: string,
  /** The server's: `deriveAuthSecret` of the key it runs with, or the cookie is refused. */
  secret: string,
): Promise<string> => {
  assertDemoDatabase(connectionString);
  const user = await database
    .selectFrom('users')
    .select('id')
    .where('username', '=', username)
    .executeTakeFirst();
  if (user === undefined) throw new Error(`nobody called ${username} is in this database`);
  return (await issueSession(database, clock, secret, user.id, SESSION_DAYS)).token;
};

/**
 * Somebody new, in no workspace, signed in once — in a scratch database only. The write budget is
 * per person (`WRITE_BUDGET`), and the four seeded people are shared by every test of a browser run
 * at once: a test whose own writes are many, or whose page must not wait behind another test's, is
 * given people nobody else spends.
 */
export const freshPerson = async (
  database: Executor,
  clock: Clock,
  connectionString: string,
  username: string,
  /** The server's: `deriveAuthSecret` of the key it runs with, or the cookie is refused. */
  secret: string,
): Promise<{ readonly userId: string; readonly token: string }> => {
  assertDemoDatabase(connectionString);
  const user = await database
    .insertInto('users')
    .values({
      email: `${username}@elsewhere.example`,
      username,
      display_name: username.charAt(0).toUpperCase() + username.slice(1),
      github_id: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const { token } = await issueSession(database, clock, secret, user.id, SESSION_DAYS);
  return { userId: user.id, token };
};

/** What the seed hands to the two things nobody is there for: a socket to deliver to, an export to run. */
const quiet = (): void => undefined;

export const seedDemo = async (options: SeedOptions): Promise<Manifest> => {
  const { database, config } = options;
  assertDemoDatabase(config.DATABASE_URL);
  let current = new Date(options.now.getTime() - 3 * 24 * 60 * MINUTE);
  const clock: Clock = { now: (): Date => new Date(current) };
  const at = (instant: Date): void => {
    current = instant;
  };
  const advance = (minutes: number): void => {
    current = new Date(current.getTime() + minutes * MINUTE);
  };

  // Signed with the secret the served instance derives from the same key, so the cookies printed
  // for a browser are the ones the server resolves (D-179).
  const secret = demoSecret();
  const log = createLogger({ level: 'silent' });
  // The history is sent in bulk by four people, which the production write budget
  // would (rightly) refuse; the seed is not a client to rate-limit.
  const app = createApp({
    auth: createAuth({
      database,
      baseUrl: config.APP_URL,
      secret,
      log,
      settings: { github: undefined, signUp: 'invite-only' },
      githubUrls: { web: config.GITHUB_URL, api: config.GITHUB_API_URL },
      sessionTtlDays: config.SESSION_TTL_DAYS,
      // Nobody listens: the seed opens no socket.
      bus: inProcessEventBus(quiet, log),
      clock,
      // A test seeds inside a rolled-back transaction, which the library's schema check refuses.
      checkSchema: !isTransaction(database),
    }),
    config,
    // The seed stands in for the operator, whatever the server's setting says (D-155).
    workspaceCreators: () => Promise.resolve({ kind: 'anyone' }),
    database,
    clock,
    log,
    // The seed writes no attachments; the store is the one the configuration names.
    storage: storeFor(config),
    // The seed asks for no export: nothing for a runner to start.
    exportRunner: quiet,
    // Nobody is in front of a page here: the seed pushes nothing either way.
    attention: nobodyActive,
    rateBudgets: { auth: ROOMY, writes: ROOMY, costlyReads: ROOMY },
  });

  // ── People ────────────────────────────────────────────────────────────────
  const existing = await database
    .selectFrom('users')
    .select('id')
    .where('username', 'in', [...Object.keys(PERSONAS), ...Object.keys(OUTSIDERS)])
    .execute();
  if (existing.length > 0) {
    throw new Error(
      'the demo people already exist in this database; the seed is for a fresh one (scripts/demo.ts creates it)',
    );
  }

  const keys = Object.keys(PERSONAS) as PersonaKey[];
  const people = {} as Record<PersonaKey, Persona>;
  for (const key of keys) {
    const profile = PERSONAS[key];
    const user = await database
      .insertInto('users')
      .values({
        email: `${key}@acme.example`,
        username: key,
        display_name: profile.displayName,
        github_id: profile.githubId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const { token } = await issueSession(database, clock, secret, user.id, SESSION_DAYS);
    people[key] = {
      userId: user.id,
      username: key,
      displayName: profile.displayName,
      cookie: `${SESSION_COOKIE}=${token}`,
      token,
    };
  }

  const outsiders = {} as Record<OutsiderKey, Outsider>;
  for (const [key, githubId] of Object.entries(OUTSIDERS) as [OutsiderKey, number][]) {
    const user = await database
      .insertInto('users')
      .values({
        email: `${key}@elsewhere.example`,
        username: key,
        display_name: key.charAt(0).toUpperCase() + key.slice(1),
        github_id: githubId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const first = await issueSession(database, clock, secret, user.id, SESSION_DAYS);
    const second = await issueSession(database, clock, secret, user.id, SESSION_DAYS);
    outsiders[key] = { userId: user.id, username: key, tokens: [first.token, second.token] };
  }

  // ── The request every step goes through ───────────────────────────────────
  const call = async (
    who: PersonaKey,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const response = await app.handle(
      new Request(`${config.APP_URL}${path}`, {
        method,
        headers: {
          cookie: people[who].cookie,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path} as ${who} answered ${String(response.status)}: ${text}`);
    }
    return text === '' ? null : (JSON.parse(text) as unknown);
  };
  const idOf = (value: unknown): string => (value as { id: string }).id;

  // ── Workspace and channels ────────────────────────────────────────────────
  at(new Date(options.now.getTime() - 3 * 24 * 60 * MINUTE));
  const workspace = (await call('dogancan', 'POST', '/api/workspaces', {
    name: WORKSPACE_NAME,
    slug: SLUG,
  })) as { id: string };
  for (const key of keys) {
    if (key === 'dogancan') continue;
    await database
      .insertInto('workspace_members')
      .values({
        workspace_id: workspace.id,
        user_id: people[key].userId,
        role: 'member',
        joined_at: current,
      })
      .execute();
  }

  const makeChannel = async (creator: PersonaKey, name: string, topic: string): Promise<string> =>
    idOf(await call(creator, 'POST', `/api/workspaces/${workspace.id}/channels`, { name, topic }));
  const join = async (who: PersonaKey, channelId: string): Promise<void> => {
    await call(who, 'POST', `/api/channels/${channelId}/join`);
  };

  const api = await makeChannel('alice', 'api', 'Backend deploys and incident follow-ups');
  const deploys = await makeChannel('bob', 'deploys', 'Staging and production releases');
  const incidents = await makeChannel('carol', 'incidents', 'Active incidents and postmortems');
  const design = await makeChannel('dogancan', 'design', 'Product and interface decisions');
  for (const channelId of [api, deploys, incidents]) {
    for (const key of keys) {
      // The creator is already in; joining twice is not an error but is not needed.
      const creator = channelId === api ? 'alice' : channelId === deploys ? 'bob' : 'carol';
      if (key !== creator) await join(key, channelId);
    }
  }

  // The private channel: nobody can create one through the API yet (`API.md` §4).
  const security = (
    await database
      .insertInto('channels')
      .values({
        workspace_id: workspace.id,
        name: 'security',
        topic: 'Private · vulnerability reports',
        type: 'private',
        created_by: people.alice.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  await database
    .insertInto('channel_members')
    .values([
      { channel_id: security, user_id: people.alice.userId },
      { channel_id: security, user_id: people.bob.userId },
    ])
    .execute();

  const dmAlice = idOf(
    await call('dogancan', 'POST', `/api/workspaces/${workspace.id}/dms`, {
      userId: people.alice.userId,
    }),
  );
  const dmSelf = idOf(
    await call('dogancan', 'POST', `/api/workspaces/${workspace.id}/dms`, {
      userId: people.dogancan.userId,
    }),
  );

  // ── The conversation ──────────────────────────────────────────────────────
  const named: Record<string, string> = {};
  const readTo: Partial<Record<string, string>> = {};
  let total = 0;

  const say = async (
    who: PersonaKey,
    channelId: string,
    text: string,
    parentId?: string,
  ): Promise<string> => {
    const id = messageId(clock.now());
    await call(who, 'POST', `/api/channels/${channelId}/messages`, {
      id,
      content: text,
      ...(parentId === undefined ? {} : { parentId }),
    });
    total += 1;
    return id;
  };

  const play = async (
    channelId: string,
    channelName: string,
    steps: readonly Step[],
    endsAt: Date,
  ): Promise<void> => {
    at(new Date(endsAt.getTime() - durationMinutes(steps) * MINUTE));
    for (const step of steps) {
      advance(step.gapMinutes);
      const id = await say(step.who, channelId, step.text);
      if (step.key !== undefined) named[step.key] = id;
      if (step.readUpTo === true) readTo[channelName] = id;
      for (const reaction of step.reactions ?? []) {
        for (const by of reaction.by) {
          await call(
            by,
            'PUT',
            `/api/messages/${id}/reactions/${encodeURIComponent(reaction.emoji)}`,
          );
        }
      }
      for (const reply of step.replies ?? []) {
        advance(reply.gapMinutes);
        await say(reply.who, channelId, reply.text, id);
      }
      if (step.resolvedBy !== undefined) {
        advance(2);
        await call(step.resolvedBy, 'POST', `/api/messages/${id}/resolve`);
      }
    }
  };

  const end = options.now;
  const ago = (minutes: number): Date => new Date(end.getTime() - minutes * MINUTE);
  await play(api, 'api', apiChannel(), ago(25));
  await play(deploys, 'deploys', deploysChannel(), ago(95));
  await play(incidents, 'incidents', incidentsChannel(), ago(300));
  await play(security, 'security', securityChannel(), ago(700));
  await play(dmAlice, 'dmAlice', directMessages(), ago(60));
  await play(dmSelf, 'dmSelf', selfNotes(), ago(180));

  // What the viewer has read, set last so the counters are recomputed over the whole
  // history (D-99 §4) — the way a person who read to here and then went to lunch is.
  at(ago(10));
  const channelIds: Record<string, string> = { api, deploys, dmAlice, dmSelf };
  for (const [name, upTo] of Object.entries(readTo)) {
    const channelId = channelIds[name];
    if (channelId !== undefined && upTo !== undefined) {
      await call('dogancan', 'PUT', `/api/channels/${channelId}/read`, { lastReadMessageId: upTo });
    }
  }

  return {
    workspace: { id: workspace.id, slug: SLUG, name: WORKSPACE_NAME },
    personas: people,
    outsiders,
    channels: { api, deploys, incidents, design, security, dmAlice, dmSelf },
    messages: named,
    counts: { messages: total },
  };
};

/** What the seed will send, without sending it: for the harness's banner and a test. */
export const plannedMessages = (): number =>
  [
    apiChannel(),
    deploysChannel(),
    incidentsChannel(),
    securityChannel(),
    directMessages(),
    selfNotes(),
  ].reduce((sum, steps) => sum + messageCount(steps), 0);
