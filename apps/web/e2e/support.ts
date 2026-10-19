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
import { expect, type Locator, type Page } from '@playwright/test';
import { messageId, type Message } from '@purlay/types';

export type Persona = 'dogancan' | 'alice' | 'bob' | 'carol';

/*
 * Who does what, because the write budget is per person (10 a second, a burst of 20; a send over
 * the socket that exceeds it fails with "You are going too fast") and a project's tests run in
 * parallel against one world:
 *   dogancan, alice  the people a test drives through the page. Their budget is the page's.
 *   carol, bob       the people who write what is already there — histories, questions, replies —
 *                    through the API, and who make the rooms. Their budget is for that.
 * A test that makes alice speak through the API as well as through her page (live.e2e.ts) does so in
 * a handful of calls.
 */

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
  /** Who it speaks as: a seeded persona's name, or a newcomer's username (`fixtures.ts`). */
  readonly who: string;
  readonly get: <T>(path: string) => Promise<T>;
  readonly post: <T>(path: string, body?: unknown) => Promise<T>;
  readonly put: <T>(path: string, body?: unknown) => Promise<T>;
  readonly patch: <T>(path: string, body?: unknown) => Promise<T>;
  readonly del: <T>(path: string) => Promise<T>;
  /** Sends a root or a reply and returns the message as the server has it. */
  readonly say: (
    channelId: string,
    content: string,
    options?: { readonly parentId?: string; readonly id?: string },
  ) => Promise<Message>;
  readonly react: (messageId: string, emoji: string) => Promise<void>;
  /** Replaces the content of one of this person's own messages (D-103). */
  readonly edit: (messageId: string, content: string) => Promise<Message>;
  /** Deletes a message this person may delete: their own, or as a workspace admin (D-103 §7). */
  readonly remove: (messageId: string) => Promise<void>;
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

export const apiAs = (tenant: Tenant, persona: Persona): ApiClient =>
  sessionApi({
    baseURL: tenant.baseURL,
    workspaceId: tenant.workspaceId,
    token: tenant.tokens[persona],
    who: persona,
  });

/** The same client for any session: a seeded persona's, or a newcomer's in a workspace of their own. */
export const sessionApi = (session: {
  readonly baseURL: string;
  /** The workspace `channelState` reads; a newcomer's client has none, and refuses to guess one. */
  readonly workspaceId: string | undefined;
  readonly token: string;
  readonly who: string;
}): ApiClient => {
  const { who } = session;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await fetch(`${session.baseURL}${path}`, {
        method,
        headers: {
          cookie: `__Host-purlay_session=${session.token}`,
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
        throw new Error(`${method} ${path} as ${who} answered ${String(response.status)}: ${text}`);
      }
      return (text === '' ? null : JSON.parse(text)) as T;
    }
    throw new Error(`${method} ${path} as ${who} stayed rate limited`);
  };

  const client: ApiClient = {
    who,
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path, body) => call('PUT', path, body),
    patch: (path, body) => call('PATCH', path, body),
    del: (path) => call('DELETE', path),
    say: (channelId, content, options = {}) =>
      call<Message>('POST', `/api/channels/${channelId}/messages`, {
        id: options.id ?? messageId(wallClock()),
        content,
        ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
      }),
    edit: (id, content) => call<Message>('PATCH', `/api/messages/${id}`, { content }),
    remove: async (id) => {
      await call<null>('DELETE', `/api/messages/${id}`);
    },
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
      if (session.workspaceId === undefined) {
        throw new Error(`${who}'s client was made with no workspace to read the channels of`);
      }
      const channels = await call<{ id: string; state: Json | null }[]>(
        'GET',
        `/api/workspaces/${session.workspaceId}/channels`,
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
  // Brought in by the creator (D-104), not each joining: a join is a write charged to the person
  // who joins, and every room of a run joining dogancan and alice spent the budget their pages
  // send with — most of the `429`s a loaded run met were alice's page, starved by other tests'
  // joins in her name.
  const maker = apiAs(tenant, creator);
  for (const person of members.filter((member) => member !== creator)) {
    await maker.post(`/api/channels/${made.id}/members`, { userId: tenant.userIds[person] });
  }
  for (const message of options.messages ?? []) {
    await apiAs(tenant, message.by).say(made.id, message.text);
  }
  return { id: made.id, name, path: `/w/${tenant.slug}/c/${made.id}` };
};

/**
 * `count` plain messages from carol and bob in turn. The write budget is per person, and alice and
 * the viewer are the people tests drive through the page: a long history written in their names
 * would leave the page without budget to send with.
 */
export const history = (
  count: number,
  by: readonly Persona[] = ['carol', 'bob'],
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

/** Below this width the sidebar is an overlay behind the "Open navigation" toggle (`UX.md` §2). */
const NARROW_BELOW_PX = 900;

export const isNarrow = (page: Page): boolean =>
  (page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) < NARROW_BELOW_PX;

/**
 * The app's frame is up — the sidebar at a desktop width, its toggle at a narrow one — and the
 * screen has its title. Keys are listened for only after this. At a narrow width a thread open in
 * its panel covers the channel, toggle and title included (D-122), so the panel's own heading is
 * the frame then.
 */
export const shellReady = async (page: Page): Promise<void> => {
  const toggle = page.getByRole('button', { name: 'Open navigation' });
  const thread = page.getByRole('heading', { level: 2, name: /^Thread · / });
  await expect(
    toggle
      .or(page.getByRole('complementary', { name: 'Workspace' }))
      .or(thread)
      .first(),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 }).or(thread).first()).toBeVisible();
};

/** The workspace sidebar, wherever this width keeps it: in place, or inside the overlay's dialog. */
const sidebarOf = (page: Page): Locator => page.getByRole('complementary', { name: 'Workspace' });

/** Opens the sidebar if it is behind its toggle, and returns it. Safe to call when it is open. */
export const openNav = async (page: Page): Promise<Locator> => {
  const toggle = page.getByRole('button', { name: 'Open navigation' });
  await expect(toggle.or(page.getByRole('complementary', { name: 'Workspace' }))).toBeVisible();
  if (await toggle.isVisible()) await toggle.click();
  const sidebar = sidebarOf(page);
  await expect(sidebar).toBeVisible();
  return sidebar;
};

/**
 * A page of Settings (D-146), opened at its address, once its chunk has loaded and drawn the page's
 * title; returns the main column the page is in.
 */
export const openSettings = async (
  page: Page,
  slug: string,
  section: string,
  title: string,
): Promise<Locator> => {
  await page.goto(`/w/${slug}/settings/${section}`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: title })).toBeVisible();
  return main;
};

/** A place on the rail — the inbox, the open questions, search — with the navigation open (D-110). */
export const railLink = async (page: Page, name: string): Promise<Locator> => {
  await openNav(page);
  return page.getByRole('navigation', { name: 'Places' }).getByRole('link', { name });
};

/** The sidebar entry of a channel (its name may be preceded by "unread"), with the sidebar open. */
export const navLink = async (page: Page, name: string): Promise<Locator> =>
  (await openNav(page)).getByRole('link', { name: new RegExp(`^(unread )?${name}`) });

/**
 * Opens a panel beside the conversation (D-129, D-130) as a person does at this width: its own
 * button on a wide window, the header's one menu of them on a narrow one.
 */
export const openPanel = async (
  page: Page,
  name: 'Files in this channel' | 'Pinned messages',
): Promise<void> => {
  if (isNarrow(page)) {
    await page.getByRole('button', { name: 'Channel menu' }).click();
    await page.getByRole('menuitem', { name }).click();
  } else {
    await page.getByRole('button', { name }).click();
  }
};
