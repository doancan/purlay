/**
 * The same small world for every test: one person, one workspace, a few channels, and an
 * `Api` that tells them so.
 *
 * Ids are fixed and readable so a failure names what it is about, and a message's id is
 * a real UUIDv7 made from its position, so ordering in a test is ordering in production.
 * `aSignedInApi` is the usual starting point: it answers `me` and the channel list, and
 * refuses everything else — so a screen that reaches for an endpoint the test did not
 * expect fails by name (`fake-api.ts`).
 */
import type { Channel, MeResponse, Message, User, Workspace, WorkspaceMember } from '@purlay/types';
import type { Api } from '../data/api';
import { anApi } from './fake-api';

export const IDS = {
  me: '00000000-0000-4000-8000-0000000000e1',
  alice: '00000000-0000-4000-8000-0000000000e2',
  bob: '00000000-0000-4000-8000-0000000000e3',
  workspace: '00000000-0000-4000-8000-0000000000a1',
  api: '00000000-0000-4000-8000-0000000000c1',
  deploys: '00000000-0000-4000-8000-0000000000c2',
  incidents: '00000000-0000-4000-8000-0000000000c3',
  browse: '00000000-0000-4000-8000-0000000000c4',
  dm: '00000000-0000-4000-8000-0000000000c5',
} as const;

export const WHEN = '2026-09-09T08:00:00.000Z';

export const aUser = (name: string, id: string): User => ({
  id,
  username: name,
  displayName: name.charAt(0).toUpperCase() + name.slice(1),
  avatarUrl: null,
});

export const ME = aUser('dogancan', IDS.me);
export const ALICE = aUser('alice', IDS.alice);
export const BOB = aUser('bob', IDS.bob);

export const WORKSPACE: Workspace = {
  id: IDS.workspace,
  name: 'acme-eng',
  slug: 'acme',
  avatarUrl: null,
};

export const aSession = (): MeResponse => ({
  user: { ...ME, email: 'dogancan@example.test' },
  memberships: [{ workspace: WORKSPACE, role: 'owner', joinedAt: WHEN, deepWorkUntil: null }],
});

export const aChannel = (
  id: string,
  name: string | null,
  over: Partial<Channel> = {},
): Channel => ({
  id,
  workspaceId: IDS.workspace,
  name,
  topic: null,
  type: 'public',
  lastMessageAt: null,
  state: { lastReadMessageId: null, unreadCount: 0, unreadMentionCount: 0 },
  peer: null,
  notificationLevel: 'mentions',
  ...over,
});

/** `api`, `deploys` and `incidents` are joined; `browse` is public and not joined. */
export const someChannels = (): Channel[] => [
  aChannel(IDS.api, 'api', { topic: 'Backend deploys and incident follow-ups' }),
  aChannel(IDS.deploys, 'deploys'),
  aChannel(IDS.incidents, 'incidents'),
  aChannel(IDS.browse, 'browse', { state: null }),
];

/** The id of the `n`th message of a test, a UUIDv7 that sorts by `n`. */
export const messageIdAt = (n: number): string =>
  `0199155c-${(0x6200 + n).toString(16).padStart(4, '0')}-7b7f-8c11-2a4d3f9e1b70`;

export const aMessage = (n: number, over: Partial<Message> = {}): Message => ({
  id: messageIdAt(n),
  channelId: IDS.api,
  sender: ALICE,
  content: `message ${String(n)}`,
  editedAt: null,
  deletedAt: null,
  createdAt: new Date(Date.UTC(2026, 8, 9, 8, 0, n)).toISOString(),
  parentId: null,
  thread: { replyCount: 0, lastReplyAt: null, resolvedAt: null, resolvedBy: null },
  reactions: [],
  mentions: [],
  ...over,
});

/** Everyone in the workspace: the person, and two others. */
export const someMembers = (): WorkspaceMember[] =>
  [ME, ALICE, BOB].map((user) => ({ user, role: 'member' as const, joinedAt: WHEN }));

export const aSignedInApi = (overrides: Partial<Api> = {}): Api =>
  anApi({
    me: () => Promise.resolve(aSession()),
    channels: () => Promise.resolve(someChannels()),
    // What the sidebar asks for on every signed-in screen.
    members: () => Promise.resolve(someMembers()),
    unresolved: () => Promise.resolve({ data: [], nextCursor: null }),
    ...overrides,
  });
