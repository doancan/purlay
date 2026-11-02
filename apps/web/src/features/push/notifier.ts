/**
 * The page's own notices (D-148): what an open tab in the background shows the person, through the
 * browser's `Notification` directly — no worker, no server key. A port, the browser's by default;
 * `null` where the browser has none.
 *
 * Its permission is the same one Web Push uses (D-126): the browser keeps one answer per site, so
 * "notifications on this device" is one switch over both.
 */

/** One notice: replaced, not added to, by the next with the same `tag`. */
export interface Notice {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  /** The person clicked it: the page is brought to the front first. */
  readonly onOpen: () => void;
}

export interface Notifier {
  /** What the person told the browser about notifications for this site. */
  readonly permission: () => NotificationPermission;
  /** Asks, if it was never asked; the answer otherwise. */
  readonly request: () => Promise<NotificationPermission>;
  /**
   * Shows it; `false` where the browser refused to — a phone's browser allows notices only from a
   * worker, and there the page in the background is not running anyway (Web Push tells it).
   */
  readonly show: (notice: Notice) => boolean;
  /** Takes back the notice with this tag, if this page showed one: what it said is no longer so. */
  readonly close: (tag: string) => void;
}

/** Where the picture beside a notice comes from: the product's own mark. */
const ICON = '/favicon.svg';

/** The browser's, or `null` where it has no notifications. */
export const browserNotifier = (): Notifier | null => {
  if (typeof window === 'undefined' || !('Notification' in window)) return null;
  const shown = new Map<string, Notification>();
  return {
    permission: () => Notification.permission,
    request: async (): Promise<NotificationPermission> =>
      Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission,
    show: ({ title, body, tag, onOpen }): boolean => {
      if (Notification.permission !== 'granted') return false;
      let notice: Notification;
      try {
        notice = new Notification(title, {
          body,
          tag,
          icon: ICON,
          lang: document.documentElement.lang,
        });
      } catch (refused) {
        // Chrome on Android: "Illegal constructor", only a worker may. Anything else is not expected.
        if (refused instanceof TypeError) return false;
        throw refused;
      }
      shown.set(tag, notice);
      notice.onclick = (): void => {
        window.focus();
        onOpen();
        notice.close();
      };
      notice.onclose = (): void => {
        if (shown.get(tag) === notice) shown.delete(tag);
      };
      return true;
    },
    close: (tag): void => {
      shown.get(tag)?.close();
      shown.delete(tag);
    },
  };
};
