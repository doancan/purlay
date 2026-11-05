/**
 * What the page read before its socket opened is read again once it has (D-267): a change made between
 * the page's reads and the socket's opening is in no frame, so nothing but that second read could show it.
 */
import { expect, test } from './fixtures';
import { shellReady, wallClock } from './support';

const NO_DEEP_WORK = /Deep Work until/;

test('Deep Work started after the page read the person and before its socket opened shows without a reload', async ({
  asOutsider,
  workspaceOf,
}) => {
  const workspace = await workspaceOf('frank');
  const page = await asOutsider('frank');
  // The socket is not connected to the server until released: the page reads everything and listens to
  // nobody, the window that a slow network opens for as long as it likes, made as long as this test needs.
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.routeWebSocket(/\/ws$/, async (ws) => {
    await released;
    const server = ws.connectToServer();
    ws.onMessage((frame) => {
      server.send(frame);
    });
    server.onMessage((frame) => {
      ws.send(frame);
    });
  });
  await page.goto(`/w/${workspace.slug}`);
  const bar = page.getByRole('status').filter({ hasText: NO_DEEP_WORK });
  await expect(page.getByRole('navigation').first()).toBeAttached();
  await expect(bar).toHaveCount(0);

  const until = new Date(wallClock().getTime() + 2 * 60 * 60_000).toISOString();
  const response = await page.request.put(`/api/workspaces/${workspace.id}/deep-work`, {
    data: { active: true, until },
  });
  expect(response.ok()).toBe(true);
  release();

  await expect(bar).toBeVisible();
});

test('a cold load reads the person and the members once more, and who is online once', async ({
  asPerson,
  room,
}) => {
  const here = await room();
  const page = await asPerson('dogancan');
  const reads: string[] = [];
  let sockets = 0;
  page.on('websocket', () => {
    sockets += 1;
  });
  page.on('request', (request) => {
    if (request.method() !== 'GET') return;
    const { pathname } = new URL(request.url());
    if (/^\/api\/(me|workspaces\/[^/]+\/(members|presence))$/.test(pathname)) reads.push(pathname);
  });
  await page.goto(here.path);
  await shellReady(page);
  await expect.poll(() => reads.filter((path) => path.endsWith('/presence')).length).toBe(1);
  // Settled: nothing more arrives on its own, however long the page stays.
  await page.waitForLoadState('networkidle');
  const count = (suffix: string): number => reads.filter((path) => path.endsWith(suffix)).length;
  expect(sockets).toBe(1);
  expect(count('/presence')).toBe(1);
  // The page's own read and the open's: never one on a timer or per render.
  expect(count('/me')).toBe(2);
  expect(count('/members')).toBe(2);
});
