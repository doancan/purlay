/**
 * A workspace, a channel, a root and GitHub's stand-in, for the tests of GitHub work over HTTP (D-246): the App
 * installed, the person authorized, the clock a field the test may move. Shared so that creating, linking and
 * following an issue are each tried in the same world.
 */
import { expect } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import type { Executor } from '@purlay/db';
import { GitHubIssueOutcome, messageId, type Message } from '@purlay/types';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { keepAuthorization } from '../modules/integrations/github-app';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../platform/config';
import { credentialCipher } from '../platform/crypto';
import { SESSION_COOKIE } from '../platform/cookies';
import { fixedClock } from '../platform/clock';
import { testDependencies } from './doubles';
import { aGitHubAppStub, GITHUB_APP_STUB, type GitHubAppStub } from './github-app-stub';
import { aGitHubStub } from './github-stub';
import { aRoom } from './rooms';
import { aSession } from './signed-in';

export const NOW = new Date('2026-11-01T12:00:00.000Z');
export const PERSON = { id: 501, login: 'ayse-dev' };
export const API = { id: 77, fullName: 'acme/api', private: true };
export const WEB = { id: 78, fullName: 'acme/web', private: false };
const cipher = credentialCipher(DEVELOPMENT_ENCRYPTION_KEY);

export interface World {
  /** The application itself, for a request that is not a person's (GitHub's delivery). */
  readonly app: HttpApplication;
  readonly call: (method: string, path: string, who: Person, body?: unknown) => Promise<Response>;
  readonly github: GitHubAppStub;
  readonly time: { now: Date };
  readonly db: Executor;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly rootId: string;
  readonly owner: Person;
  readonly member: Person;
  readonly outsider: Person;
}

export interface Person {
  readonly userId: string;
  readonly cookie: string;
}

export const aWorld = async (
  db: Executor,
  options: {
    readonly type?: 'public' | 'private';
    readonly installed?: boolean;
    /** How long a call to GitHub may take before it is taken as lost. */
    readonly deadlineMs?: number;
    readonly authorized?: boolean;
  } = {},
): Promise<World> => {
  const room = await aRoom(db, ['owner', 'member'], {
    type: options.type ?? 'public',
    outsiders: ['outsider'],
  });
  const time = { now: NOW };
  const github = aGitHubAppStub(PERSON, { now: () => time.now.getTime() });
  github.install(31, 'acme', [API, WEB]);
  const stub = aGitHubStub({ ...PERSON, name: null, email: 'ayse@example.test' }, {}, undefined, {
    app: github,
  });
  const appFetch: typeof stub.appFetch = async (url, init) =>
    await stub.appFetch(url, {
      ...init,
      signal: AbortSignal.timeout(options.deadlineMs ?? 5_000),
    });
  const app = createApp(
    testDependencies({
      database: db,
      clock: { now: () => time.now },
      githubApp: () => GITHUB_APP_STUB,
      githubAppFetch: appFetch,
    }),
  );
  const personOf = async (name: string): Promise<Person> => {
    const userId =
      room.members[name]?.userId ??
      room.outsiders[name]?.userId ??
      '00000000-0000-4000-8000-000000000000';
    const { token } = await aSession(db, fixedClock(NOW), userId, 30);
    return { userId, cookie: `${SESSION_COOKIE}=${token}` };
  };
  const owner = await personOf('owner');
  const member = await personOf('member');
  const outsider = await personOf('outsider');
  if (options.installed !== false) {
    await db
      .insertInto('github_app_installations')
      .values({
        id: crypto.randomUUID(),
        workspace_id: room.workspaceId,
        installation_id: '31',
        account_login: 'acme',
        account_type: 'Organization',
        connected_by: owner.userId,
        connected_at: NOW,
      })
      .execute();
  }
  if (options.authorized !== false) {
    await keepAuthorization(
      db,
      { clock: { now: () => time.now }, cipher },
      owner.userId,
      PERSON,
      github.grantUser(),
    );
  }
  const call: World['call'] = async (method, path, who, body) =>
    await app.handle(
      new Request(`https://purlay.test${path}`, {
        method,
        headers: {
          cookie: who.cookie,
          origin: 'https://purlay.test',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const rootId = messageId(NOW);
  const sent = await call('POST', `/api/channels/${room.channelId}/messages`, owner, {
    id: rootId,
    content: 'How should the retry back off?',
  });
  expect(sent.status).toBe(201);
  return {
    app,
    call,
    github,
    time,
    db,
    workspaceId: room.workspaceId,
    channelId: room.channelId,
    rootId,
    owner,
    member,
    outsider,
  };
};

export const request = (
  over: Record<string, unknown> = {},
): {
  clientRequestId: string;
  repositoryId: number;
  title: string;
  body: string;
  copyPrivateText: boolean;
} => ({
  clientRequestId: crypto.randomUUID(),
  repositoryId: API.id,
  title: 'Retry with jitter',
  body: 'Decided: exponential, with jitter.',
  copyPrivateText: false,
  ...over,
});

export const create = async (
  world: World,
  body: unknown,
  who: Person = world.owner,
  at: string = world.rootId,
): Promise<{ status: number; headers: Headers; json: unknown }> => {
  const response = await world.call('POST', `/api/messages/${at}/github-issue`, who, body);
  return { status: response.status, headers: response.headers, json: await response.json() };
};

export const outcomeOf = (json: unknown): GitHubIssueOutcome => {
  if (!Value.Check(GitHubIssueOutcome, json)) throw new Error('not a GitHubIssueOutcome');
  return json;
};

export const codeOf = (json: unknown): string => (json as { error: { code: string } }).error.code;

export const rootOf = async (world: World): Promise<Message> => {
  const page = (await (
    await world.call('GET', `/api/channels/${world.channelId}/messages`, world.owner)
  ).json()) as { data: Message[] };
  const found = page.data.find((message) => message.id === world.rootId);
  if (found === undefined) throw new Error('the root is not on the page');
  return found;
};
