/**
 * The push worker as the build serves it (#78, D-126): at the root, a script, and given a push by
 * the browser itself — Chromium's DevTools protocol delivers one the way a push service would,
 * after decryption — it shows a notice, the plain one when it cannot read what it was given.
 *
 * The one thing replaced is the browser's notification surface: the headless browser refuses
 * notifications whatever it is granted (`Notification.permission` stays `denied`), so inside the
 * worker `showNotification` records what it was asked to show. The event, its parsing and its
 * wiring are the build's own.
 *
 * One project: a worker draws nothing of the page, so the theme and the width do not touch it.
 */
import type { Worker } from '@playwright/test';
import { expect, test } from './fixtures';

interface Shown {
  readonly title: string;
  readonly body: string | undefined;
  readonly tag: string | undefined;
  readonly url: unknown;
}

declare global {
  // The record the stubbed surface keeps, inside the worker.
  var shownNotices: Shown[] | undefined;
}

const shown = (worker: Worker): Promise<Shown[]> =>
  worker.evaluate(() => globalThis.shownNotices ?? []);

test.describe('the push worker', () => {
  test.skip(
    () => test.info().project.name !== 'chromium-dark',
    'a worker draws nothing of the page',
  );

  test('is served at the root, and shows what it is pushed — plainly when it cannot read it', async ({
    page,
    context,
    baseURL,
  }) => {
    const served = await page.request.get('/push-worker.js');
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toContain('javascript');
    expect(await served.text()).not.toMatch(/^\s*import\b/m);

    const devtools = await context.newCDPSession(page);
    const registered = new Promise<string>((resolve) => {
      devtools.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
        const ours = registrations.find((registration) => !registration.isDeleted);
        if (ours !== undefined) resolve(ours.registrationId);
      });
    });
    await devtools.send('ServiceWorker.enable');
    const started = context.waitForEvent('serviceworker');
    await page.goto('/');
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
        });
        return Promise.resolve();
      };
    });
    const registrationId = await registered;
    const push = async (data: string): Promise<void> => {
      await devtools.send('ServiceWorker.deliverPushMessage', {
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
      .toEqual([{ title: 'Alice in #api', body: 'mentioned you', tag: 'c:1', url: '/w/a/c/1' }]);

    await push('not what the server sends');
    await expect
      .poll(() => shown(worker))
      .toContainEqual({ title: 'Purlay', body: '', tag: 'purlay', url: '/' });
  });
});
