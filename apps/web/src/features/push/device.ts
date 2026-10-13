/**
 * This browser's side of Web Push (#78, D-126): the worker, the permission and the subscription. A
 * port, the browser's by default; `null` where it cannot be told at all. The worker is registered
 * only when somebody turns this on, never on load.
 */
import { Value } from '@sinclair/typebox/value';
import { PushOpenMessage } from '@purlay/types';

/** A subscription as the server is sent it, and the key it was made with. */
export interface DeviceSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  /** The application-server key it was made with: a key the server replaced makes it stale. */
  readonly serverKey: string;
}

export interface PushDevice {
  /** What the person told the browser about notifications for this site. */
  readonly permission: () => NotificationPermission;
  /** The subscription this browser holds for the site, if any. */
  readonly current: () => Promise<DeviceSubscription | null>;
  /**
   * Asks for permission if it was never asked, and subscribes with the server's key — replacing a
   * subscription made with another. `null` when the person did not allow it.
   */
  readonly subscribe: (serverKey: string) => Promise<DeviceSubscription | null>;
  readonly unsubscribe: () => Promise<void>;
  /** Hears the worker ask for a path when its notification is clicked; returns the unsubscribe. */
  readonly onOpen: (listener: (url: string) => void) => () => void;
}

/** Where the build puts the worker: at the root, so its scope is the whole application. */
export const PUSH_WORKER_PATH = '/push-worker.js';

const toBase64Url = (bytes: ArrayBuffer | null): string => {
  if (bytes === null) return '';
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const described = (subscription: PushSubscription): DeviceSubscription => ({
  endpoint: subscription.endpoint,
  p256dh: toBase64Url(subscription.getKey('p256dh')),
  auth: toBase64Url(subscription.getKey('auth')),
  serverKey: toBase64Url(subscription.options.applicationServerKey),
});

/**
 * The registration once its worker is active. `ready` would wait for ever on a worker that failed
 * to install, and the switch with it; this says so instead.
 */
const activated = (registration: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> =>
  new Promise((resolve, reject) => {
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    const settle = (): void => {
      if (worker?.state === 'activated') resolve(registration);
      else if (worker === null || worker.state === 'redundant') {
        reject(new Error('the push worker did not install'));
      }
    };
    worker?.addEventListener('statechange', settle);
    settle();
  });

/** The browser's, or `null` where it has no service worker, no push or no notifications. */
export const browserPushDevice = (): PushDevice | null => {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return null;
  }
  const held = async (): Promise<PushSubscription | null> => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    return registration === undefined ? null : await registration.pushManager.getSubscription();
  };
  return {
    permission: () => Notification.permission,
    current: async (): Promise<DeviceSubscription | null> => {
      const subscription = await held();
      return subscription === null ? null : described(subscription);
    },
    subscribe: async (serverKey): Promise<DeviceSubscription | null> => {
      const permission =
        Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;
      if (permission !== 'granted') return null;
      const registration = await activated(
        await navigator.serviceWorker.register(PUSH_WORKER_PATH, { scope: '/' }),
      );
      const existing = await registration.pushManager.getSubscription();
      // A subscription made with another key cannot be re-made with this one until it is gone.
      if (existing !== null && described(existing).serverKey !== serverKey) {
        await existing.unsubscribe();
      }
      return described(
        await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: fromBase64Url(serverKey),
        }),
      );
    },
    unsubscribe: async (): Promise<void> => {
      await (await held())?.unsubscribe();
    },
    onOpen: (listener) => {
      const heard = (event: MessageEvent): void => {
        const data: unknown = event.data;
        if (Value.Check(PushOpenMessage, data)) listener(data.url);
      };
      navigator.serviceWorker.addEventListener('message', heard);
      return (): void => {
        navigator.serviceWorker.removeEventListener('message', heard);
      };
    },
  };
};
