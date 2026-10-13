/**
 * The push worker (#78, D-126), built to `/push-worker.js` so its scope is the whole application.
 *
 * It does two things and nothing else — no caching, no fetch handler, no offline page:
 *
 * - **A push is always shown** (D-126 §5), folded by its tag so a busy channel is one notice.
 * - **A click goes to the conversation**: in a tab already open — focused, and told the path,
 *   because a worker cannot navigate a tab it does not control — or in a new one.
 *
 * It is served under the policy every non-document file carries (`default-src 'none'`), so it can
 * reach nothing; re-subscribing when the browser replaces a subscription is the page's, on its next
 * load (`features/push/push.tsx`).
 */
import { noticeOf, openMessage, pathOf, tabFor } from './notice';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('push', (event) => {
  const notice = noticeOf(event.data?.text() ?? null);
  event.waitUntil(
    self.registration.showNotification(notice.title, {
      body: notice.body,
      tag: notice.tag,
      icon: '/favicon.svg',
      data: { url: notice.url },
    }),
  );
});

const show = async (url: string): Promise<void> => {
  const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const tab = tabFor(tabs);
  if (tab === undefined) {
    await self.clients.openWindow(url);
    return;
  }
  tab.postMessage(openMessage(url));
  await tab.focus();
};

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data: unknown = event.notification.data;
  event.waitUntil(
    show(pathOf(typeof data === 'object' && data !== null ? Reflect.get(data, 'url') : null)),
  );
});
