/**
 * The push worker as the build serves it (#78, D-126): at the root, a script, and given a push by
 * the browser itself — Chromium's DevTools protocol delivers one the way a push service would,
 * after decryption — it shows a notice with every app tab closed, the plain one when it cannot
 * read what it was given. Clicking a shown notice hands its conversation to the open app.
 *
 * The one thing replaced is the browser's notification surface: the headless browser refuses
 * notifications whatever it is granted (`Notification.permission` stays `denied`), so inside the
 * worker `showNotification` records what it was asked to show. A synthetic click supplies the
 * notice and records the focus request. Worker event handling, client messaging and app routing
 * are the build's own.
 *
 * One project: a worker draws nothing of the page, so the theme and the width do not touch it.
 */
import type { CDPSession, Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures';
import { shellReady } from './support';

interface Shown {
  readonly title: string;
  readonly body: string | undefined;
  readonly tag: string | undefined;
  readonly url: unknown;
  readonly renotify: boolean;
}

interface WindowClients {
  matchAll(options: { includeUncontrolled: boolean; type: 'window' }): Promise<unknown[]>;
}

declare global {
  // The record the stubbed surface keeps, inside the worker.
  var shownNotices: Shown[] | undefined;
}

const shown = (worker: Worker): Promise<Shown[]> =>
  worker.evaluate(() => globalThis.shownNotices ?? []);

const startWorker = async (
  page: Page,
  path: string,
): Promise<{ worker: Worker; registrationId: string; devtools: CDPSession }> => {
  const context = page.context();
  const devtools = await context.newCDPSession(page);
  const registered = new Promise<string>((resolve) => {
    devtools.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const ours = registrations.find((registration) => !registration.isDeleted);
      if (ours !== undefined) resolve(ours.registrationId);
    });
  });
  await devtools.send('ServiceWorker.enable');
  const started = context.waitForEvent('serviceworker');
  await page.goto(path);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/push-worker.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  });
  const worker = await started;
  expect(new URL(worker.url()).pathname).toBe('/push-worker.js');
  await worker.evaluate(() => {
    globalThis.shownNotices = [];
    const scope = globalThis as unknown as { registration: ServiceWorkerRegistration };
    scope.registration.showNotification = (title, options): Promise<void> => {
      globalThis.shownNotices?.push({
        title,
        body: options?.body,
        tag: options?.tag,
        url: (options?.data as { url?: unknown } | undefined)?.url,
        renotify: options !== undefined && Reflect.get(options, 'renotify') === true,
      });
      return Promise.resolve();
    };
  });
  return { worker, registrationId: await registered, devtools };
};

test.describe('the push worker', () => {
  test.skip(
    () => test.info().project.name !== 'chromium-dark',
    'a worker draws nothing of the page',
  );

  test('is served at the root and shows a push after the app tab closes', async ({
    page,
    context,
    baseURL,
  }) => {
    const served = await page.request.get('/push-worker.js');
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toContain('javascript');
    expect(await served.text()).not.toMatch(/^\s*import\b/m);

    const { worker, registrationId } = await startWorker(page, '/');
    const observer = await context.newPage();
    const delivery = await context.newCDPSession(observer);
    await delivery.send('ServiceWorker.enable');
    const appWindows = (): Promise<number> =>
      worker.evaluate(async () => {
        const scope = globalThis as unknown as { clients: WindowClients };
        return (await scope.clients.matchAll({ includeUncontrolled: true, type: 'window' })).length;
      });
    await expect.poll(appWindows).toBe(1);
    await page.close();
    await expect.poll(appWindows).toBe(0);

    const push = async (data: string): Promise<void> => {
      await delivery.send('ServiceWorker.deliverPushMessage', {
        origin: new URL(baseURL ?? '').origin,
        registrationId,
        data,
      });
    };

    await push(
      JSON.stringify({
        title: 'Alice in #api',
        body: 'mentioned you',
        url: '/w/a/c/1',
        tag: 'c:1',
      }),
    );
    await expect
      .poll(() => shown(worker))
      .toEqual([
        {
          title: 'Alice in #api',
          body: 'mentioned you',
          tag: 'c:1',
          url: '/w/a/c/1',
          renotify: true,
        },
      ]);

    await push('not what the server sends');
    await expect
      .poll(() => shown(worker))
      .toContainEqual({ title: 'Purlay', body: '', tag: 'purlay', url: '/', renotify: true });
  });

  test('clicking the worker notice opens its conversation in the app tab', async ({
    page,
    context,
    signIn,
    room,
  }) => {
    const here = await room({ members: ['dogancan'] });
    const there = await room({ members: ['dogancan'] });
    await signIn();
    const { worker, registrationId, devtools } = await startWorker(page, here.path);
    await shellReady(page);
    await expect(page).toHaveURL(here.path);

    await devtools.send('ServiceWorker.deliverPushMessage', {
      origin: new URL(page.url()).origin,
      registrationId,
      data: JSON.stringify({ title: `#${there.name}`, body: 'mentioned you', url: there.path }),
    });
    await expect.poll(() => shown(worker)).toHaveLength(1);
    const click = await worker.evaluate(async () => {
      const scope = globalThis as unknown as { clients: WindowClients };
      const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const [tab] = windows;
      const [notice] = globalThis.shownNotices ?? [];
      if (tab === undefined || notice === undefined)
        throw new Error('missing app window or notice');

      let focusRequested = false;
      // Synthetic events cannot supply the OS click's activation. Keep client messaging real.
      Object.defineProperty(Object.getPrototypeOf(tab) as object, 'focus', {
        value: (): Promise<unknown> => {
          focusRequested = true;
          return Promise.resolve(tab);
        },
      });
      let closed = false;
      const work: Promise<void>[] = [];
      const event = Object.assign(new Event('notificationclick'), {
        notification: {
          data: { url: notice.url },
          close: (): void => {
            closed = true;
          },
        },
        waitUntil: (promise: Promise<void>): void => {
          work.push(promise);
        },
      });
      (globalThis as unknown as EventTarget).dispatchEvent(event);
      await Promise.all(work);
      return { closed, focusRequested, work: work.length };
    });

    expect(click).toEqual({ closed: true, focusRequested: true, work: 1 });
    await expect(page).toHaveURL(there.path);
    await expect(
      page.getByRole('heading', { level: 1, name: there.name, exact: true }),
    ).toBeVisible();
    expect(context.pages()).toEqual([page]);
  });
});
