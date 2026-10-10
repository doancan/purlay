/**
 * The demo world, read back through the browser's own `fetch` — the same origin, the same
 * cookie, the same API a screen uses. Proves that what the screens will show exists and is
 * what the seed claims, and is where the specs written with each screen get their ids.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

interface ChannelRow {
  id: string;
  name: string | null;
  type: string;
  state: { unreadCount: number; unreadMentionCount: number } | null;
  peer: { username: string } | null;
}

interface Page_ {
  data: { id: string; thread?: { replyCount: number; resolvedAt: string | null } }[];
  nextCursor: string | null;
}

/** A GET through the page, as the page's own scripts make it: its origin, its cookies. */
const getJson = async <T>(page: Page, url: string): Promise<T> =>
  (await page.evaluate(async (target) => {
    const response = await fetch(target);
    return (await response.json()) as unknown;
  }, url)) as T;

const statusOf = async (page: Page, url: string): Promise<number> =>
  await page.evaluate(async (target) => (await fetch(target)).status, url);

test.describe('the seeded workspace, as the viewer sees it', () => {
  test.beforeEach(async ({ page, signIn }) => {
    await signIn();
    await page.goto('/sign-in');
  });

  test('knows who is signed in, and that they belong to one workspace', async ({ page, world }) => {
    const me = await getJson<{
      user: { username: string };
      memberships: { workspace: { slug: string }; role: string }[];
    }>(page, '/api/me');
    expect(me.user.username).toBe('dogancan');
    expect(me.memberships.map((m) => m.workspace.slug)).toEqual([world.workspace.slug]);
    expect(me.memberships[0]?.role).toBe('owner');
  });

  test('has the channels, the private one hidden, and the unread state the seed set', async ({
    page,
    world,
  }) => {
    const channels = await getJson<ChannelRow[]>(
      page,
      `/api/workspaces/${world.workspace.id}/channels`,
    );
    const byName = new Map(channels.map((c) => [c.name ?? c.peer?.username ?? '', c]));
    expect([...byName.keys()].sort()).toEqual([
      'alice',
      'api',
      'deploys',
      'design',
      'dogancan',
      'incidents',
    ]);
    expect(channels.some((c) => c.id === world.channels.security)).toBe(false);
    // The viewer read #deploys to the 120th of 200, and #api to the middle.
    expect(byName.get('deploys')?.state?.unreadCount).toBe(80);
    expect(byName.get('api')?.state?.unreadCount).toBeGreaterThan(5);
    expect(byName.get('api')?.state?.unreadMentionCount).toBeGreaterThanOrEqual(3);
    expect(byName.get('alice')?.state?.unreadCount).toBe(2);
    expect(byName.get('design')?.state?.unreadCount).toBe(0);
  });

  test('pages #deploys by keyset: a full page, a cursor, and an older page that does not repeat it', async ({
    page,
    world,
  }) => {
    const base = `/api/channels/${world.channels.deploys}/messages?limit=100`;
    const first = await getJson<Page_>(page, base);
    expect(first.data).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const second = await getJson<Page_>(page, `${base}&before=${first.nextCursor ?? ''}`);
    expect(second.data).toHaveLength(100);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.data, ...second.data].map((m) => m.id)).size).toBe(200);
  });

  test('lists the open questions: the open threads, and not the resolved one', async ({
    page,
    world,
  }) => {
    const open = await getJson<Page_>(page, `/api/workspaces/${world.workspace.id}/unresolved`);
    const ids = open.data.map((m) => m.id);
    expect(ids).toContain(world.messages['backoff-question']);
    expect(ids).toContain(world.messages['incident-open']);
    expect(ids).not.toContain(world.messages['legacy-route']);
    expect(open.data.every((m) => m.thread?.resolvedAt === null && m.thread.replyCount > 0)).toBe(
      true,
    );
  });

  test('keeps a private channel private: the same 404 as for one that does not exist', async ({
    page,
    world,
  }) => {
    expect([
      await statusOf(page, `/api/channels/${world.channels.security}`),
      await statusOf(page, '/api/channels/00000000-0000-4000-8000-000000000000'),
    ]).toEqual([404, 404]);
  });

  test('a socket opens for the signed-in viewer, through the same origin', async ({ page }) => {
    const outcome = await page.evaluate(
      async () =>
        await new Promise<string>((resolve) => {
          const socket = new WebSocket(`ws://${location.host}/ws`);
          socket.addEventListener('open', () => {
            socket.close();
            resolve('open');
          });
          socket.addEventListener('close', (event) => {
            resolve(`closed ${String(event.code)}`);
          });
        }),
    );
    expect(outcome).toBe('open');
  });
});
