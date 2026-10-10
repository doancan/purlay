/**
 * What a flow test needs that the page itself cannot give it: other people, and a world of
 * its own.
 *
 * **Every project of a run shares one database**, and the four run at the same time, so a test
 * that writes into a seeded channel changes what its neighbours read (reading #deploys moves
 * the unread count another test asserts on). A test that writes therefore makes its own room
 * through the real API — a channel nobody else knows the name of — and a test that only
 * reads uses the seeded world as it is. Rooms are made by the API and never by the page, so
 * the page under test is the only thing being tested.
 *
 * The API client speaks as a persona with the genuine session cookie; it waits out the
 * write budget (`429` + `Retry-After`) instead of failing on it, because a room of seventy
 * messages is more than one person's burst and a test must not be flaky for being thorough.
 */
import { messageId, type Message } from '@purlay/types';

export type Persona = 'dogancan' | 'alice' | 'bob' | 'carol';

export interface Room {
  readonly id: string;
  readonly name: string;
  /** The address of the channel in the web app. */
  readonly path: string;
}

type Json = Readonly<Record<string, unknown>>;

/** Wall-clock time without `Date.now()`: the e2e tests, like the client, take their clock from one place. */
const wallClock = (): Date => new Date(performance.timeOrigin + performance.now());

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface Tenant {
  readonly baseURL: string;
  readonly slug: string;
  readonly workspaceId: string;
  readonly tokens: Readonly<Record<Persona, string>>;
  readonly userIds: Readonly<Record<Persona, string>>;
}

export interface ApiClient {
  readonly persona: Persona;
  readonly get: <T>(path: string) => Promise<T>;
  readonly post: <T>(path: string, body?: unknown) => Promise<T>;
  readonly put: <T>(path: string, body?: unknown) => Promise<T>;
  readonly del: <T>(path: string) => Promise<T>;
  /** Sends a root or a reply and returns the message as the server has it. */
  readonly say: (
    channelId: string,
    content: string,
    options?: { readonly parentId?: string; readonly id?: string },
  ) => Promise<Message>;
  readonly react: (messageId: string, emoji: string) => Promise<void>;
  readonly resolve: (messageId: string) => Promise<void>;
  readonly markRead: (channelId: string, lastReadMessageId: string) => Promise<void>;
  readonly join: (channelId: string) => Promise<void>;
  /** This person's own view of one channel: counters and read position. */
  readonly channelState: (channelId: string) => Promise<{
    readonly lastReadMessageId: string | null;
    readonly unreadCount: number;
    readonly unreadMentionCount: number;
  } | null>;
}

export const apiAs = (tenant: Tenant, persona: Persona): ApiClient => {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await fetch(`${tenant.baseURL}${path}`, {
        method,
        headers: {
          cookie: `__Host-purlay_session=${tenant.tokens[persona]}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 429) {
        const wait = Number(response.headers.get('retry-after') ?? '1');
        await sleep(Math.max(wait, 1) * 1000);
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `${method} ${path} as ${persona} answered ${String(response.status)}: ${text}`,
        );
      }
      return (text === '' ? null : JSON.parse(text)) as T;
    }
    throw new Error(`${method} ${path} as ${persona} stayed rate limited`);
  };

  const client: ApiClient = {
    persona,
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path, body) => call('PUT', path, body),
    del: (path) => call('DELETE', path),
    say: (channelId, content, options = {}) =>
      call<Message>('POST', `/api/channels/${channelId}/messages`, {
        id: options.id ?? messageId(wallClock()),
        content,
        ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
      }),
    react: async (id, emoji) => {
      await call('PUT', `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`);
    },
    resolve: async (id) => {
      await call('POST', `/api/messages/${id}/resolve`);
    },
    markRead: async (channelId, lastReadMessageId) => {
      await call('PUT', `/api/channels/${channelId}/read`, { lastReadMessageId });
    },
    join: async (channelId) => {
      await call('POST', `/api/channels/${channelId}/join`);
    },
    channelState: async (channelId) => {
      const channels = await call<{ id: string; state: Json | null }[]>(
        'GET',
        `/api/workspaces/${tenant.workspaceId}/channels`,
      );
      const state = channels.find((c) => c.id === channelId)?.state;
      return (state ?? null) as Awaited<ReturnType<ApiClient['channelState']>>;
    },
  };
  return client;
};

let counter = 0;
/** A name no other test, project or run will pick: lowercase, hyphens, within the 64. */
export const uniqueName = (prefix: string): string => {
  counter += 1;
  const stamp = Math.floor(performance.timeOrigin + performance.now()).toString(36);
  const salt = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${stamp}${String(counter)}${salt}`.slice(0, 40);
};

export interface RoomOptions {
  /** Who the room is for; the first creates it, the rest join. The viewer is usually `dogancan`. */
  readonly members?: readonly Persona[];
  /** Messages to put in it, by the people who are in it, in order. */
  readonly messages?: readonly { readonly by: Persona; readonly text: string }[];
}

/** A channel of its own, with its people in it and its history written. */
export const makeRoom = async (tenant: Tenant, options: RoomOptions = {}): Promise<Room> => {
  const members = options.members ?? ['dogancan', 'alice'];
  // The write budget is per person, and a test drives its people through the page as well as
  // the API: four projects at once making rooms as them would spend the budget the page needs
  // to send with (the server answers `RATE_LIMITED`, and the row rightly fails). So a person
  // who is not in the test makes the room, and joins it with whoever else is not the test's.
  const outsider = (['carol', 'bob', 'alice'] as const).find((person) => !members.includes(person));
  const creator = outsider ?? members.find((person) => person !== 'dogancan') ?? 'dogancan';
  const name = uniqueName('room');
  const made = await apiAs(tenant, creator).post<{ id: string }>(
    `/api/workspaces/${tenant.workspaceId}/channels`,
    { name, topic: 'a channel a test made for itself' },
  );
  for (const person of members.filter((member) => member !== creator)) {
    await apiAs(tenant, person).join(made.id);
  }
  for (const message of options.messages ?? []) {
    await apiAs(tenant, message.by).say(made.id, message.text);
  }
  return { id: made.id, name, path: `/w/${tenant.slug}/c/${made.id}` };
};

/** `count` plain messages from the people in turn, three at a time so no one person's budget is the pace. */
export const history = (
  count: number,
  by: readonly Persona[] = ['alice', 'bob', 'carol'],
): { readonly by: Persona; readonly text: string }[] =>
  Array.from({ length: count }, (_, index) => ({
    by: by[index % by.length] ?? 'alice',
    text: `history ${String(index + 1).padStart(3, '0')}`,
  }));

/** Messages from several people at once, so a long history costs a third of the time. */
export const writeInParallel = async (
  tenant: Tenant,
  channelId: string,
  messages: readonly { readonly by: Persona; readonly text: string }[],
): Promise<void> => {
  const lanes = new Map<Persona, string[]>();
  for (const message of messages)
    lanes.set(message.by, [...(lanes.get(message.by) ?? []), message.text]);
  // Interleaving is by id, so the lanes cannot be fully parallel without scrambling the
  // history; they run in rounds of one message per person, which keeps the order.
  const longest = Math.max(...[...lanes.values()].map((texts) => texts.length));
  for (let round = 0; round < longest; round++) {
    await Promise.all(
      [...lanes.entries()].map(async ([person, texts]) => {
        const text = texts[round];
        if (text !== undefined) await apiAs(tenant, person).say(channelId, text);
      }),
    );
  }
};
