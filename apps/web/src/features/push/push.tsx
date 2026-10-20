/**
 * Notifications on this device (#78, D-126, D-148): what turns them on and off, and what keeps a
 * device that has them on told. **One switch over two things:** the notices an open tab in the
 * background shows itself (`notifier.ts`, D-148), and — where the browser has push and the server's
 * operator switched it on — Web Push for a closed tab. Both ride on the one permission the browser
 * keeps for the site, so two switches would be one answer drawn twice.
 *
 * - **Offered only where it can work:** a browser with notifications and storage to remember whose
 *   they are. Push joins where the browser has it and the server has a key (`GET /api/push/key`);
 *   without either, the switch covers the open tab alone. A key that could not be read is said.
 * - **On means the person said yes here and the browser agrees:** whose they are is remembered, and
 *   a permission taken back in the browser's settings turns them off on the next load.
 * - **A browser's subscription is honoured only for the person who made it here.** Who that was is
 *   kept with the personal data signing out forgets, so the next person to sign in on this browser
 *   finds it off — and the subscription is dropped — rather than receiving the last person's notices.
 * - **Every load re-sends it**, which ties it to this session (signing out deleted it on the server),
 *   says the language again, and replaces a subscription the server's key no longer matches.
 * - **The language follows the interface**: changed while on, the server is told.
 * - **A notice clicked goes to its conversation** in this tab, by the page's own router: the worker
 *   focuses the tab and names the path, because it cannot navigate a tab it does not control.
 *
 * The browser itself is a port (`PushDeviceContext`): the browser's when nothing is given.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PushLocale, PushSubscribeRequest } from '@purlay/types';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useClientStorage } from '../../data/storage-provider';
import { useI18n } from '../../i18n/i18n-provider';
import { useRoute } from '../../router/router-provider';
import { useToast } from '../../ui/toast';
import { browserPushDevice, type DeviceSubscription, type PushDevice } from './device';
import { browserNotifier, type Notifier } from './notifier';

/** Who turned notifications on in this browser. A personal key: signing out forgets it (`browser-storage.ts`). */
export const PUSH_OWNER_KEY = 'purlay.push.owner';

/** The device a test hands over; `undefined` is the browser's, `null` a browser with no push. */
export const PushDeviceContext = createContext<PushDevice | null | undefined>(undefined);

/** The page's own notices a test hands over; `undefined` is the browser's, `null` a browser with none. */
export const NotifierContext = createContext<Notifier | null | undefined>(undefined);

/**
 * `blocked`: the person told the browser no, and only its site settings can undo that.
 * `working`: a change is on its way, and the switch waits for it.
 */
type PushStatus = 'off' | 'on' | 'blocked' | 'working';

export interface PushControls {
  readonly status: PushStatus;
  /**
   * Whether turning it on also reaches a closed tab: the server has push keys and this browser can
   * subscribe. Without it the switch covers the open tab's notices alone (D-148), and Settings says so.
   */
  readonly closedTab: boolean;
  readonly turnOn: () => void;
  readonly turnOff: () => void;
}

interface Notifications {
  readonly controls: PushControls | null;
  readonly notifier: Notifier | null;
}

const PushContext = createContext<Notifications>({ controls: null, notifier: null });

/** The switch, or `null` where none is offered: nothing in this browser can tell the person. */
export const usePushControls = (): PushControls | null => useContext(PushContext).controls;

/**
 * The page's notices while the person has them on here, or `null`: off, blocked, not offered, or
 * a browser with none (D-148).
 */
export const useNotices = (): Notifier | null => {
  const { controls, notifier } = useContext(PushContext);
  return controls?.status === 'on' ? notifier : null;
};

const requestOf = (held: DeviceSubscription, locale: PushLocale): PushSubscribeRequest => ({
  endpoint: held.endpoint,
  keys: { p256dh: held.p256dh, auth: held.auth },
  locale,
});

/** Either port answers for the one permission the browser keeps for the site. */
type Asks = Pick<Notifier, 'permission'>;

const offOrBlocked = (asks: Asks): PushStatus =>
  asks.permission() === 'denied' ? 'blocked' : 'off';

export const PushProvider = ({
  userId,
  children,
}: {
  /** The person signed in: a subscription here is honoured only for whoever turned it on. */
  readonly userId: string;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const api = useApi();
  const { t, locale } = useI18n();
  const storage = useClientStorage();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const { navigate } = useRoute();
  const port = useContext(PushDeviceContext);
  const device = useMemo(() => (port === undefined ? browserPushDevice() : port), [port]);
  const notices = useContext(NotifierContext);
  const notifier = useMemo(() => (notices === undefined ? browserNotifier() : notices), [notices]);
  // Whichever is here answers for the permission: it is one answer, the site's.
  const asks: Asks | null = notifier ?? device;
  const key = useQuery({
    queryKey: keys.pushKey,
    queryFn: ({ signal }) => api.pushKey(signal),
    enabled: device !== null && storage !== null,
    staleTime: Infinity,
  });
  // `undefined`: the operator has push off, or the key could not be read — the open tab alone.
  const serverKey = key.data?.publicKey ?? undefined;
  // Push is judged once its key is answered; without a device there is nothing to wait for.
  const keyAnswered = device === null || storage === null || !key.isPending;
  const [status, setStatus] = useState<PushStatus | null>(null);
  // The language the server last heard from this page, so a change is sent once.
  const told = useRef<PushLocale | null>(null);

  const failed = useCallback(
    (error: unknown): void => {
      show({ message: `${t('push.failed')} ${describe(error)}` });
    },
    [show, t, describe],
  );

  useEffect(() => {
    if (key.error !== null) failed(key.error);
  }, [key.error, failed]);

  // On load: honour what this browser holds only for its owner, and re-send a subscription.
  useEffect(() => {
    if (asks === null || storage === null || !keyAnswered) return;
    const pushing = device !== null && serverKey !== undefined ? { device, serverKey } : null;
    // Nothing that could tell the person: no switch at all, rather than one that fails.
    if (notifier === null && pushing === null) return;
    let live = true;
    const reconcile = async (): Promise<PushStatus> => {
      const held = pushing === null ? null : await pushing.device.current();
      if (storage.getItem(PUSH_OWNER_KEY) !== userId) {
        if (held !== null) await pushing?.device.unsubscribe();
        return offOrBlocked(asks);
      }
      if (pushing === null) {
        if (asks.permission() === 'granted') return 'on';
        // Taken back in the browser's settings since: off, and not judged again on every load.
        storage.removeItem(PUSH_OWNER_KEY);
        return offOrBlocked(asks);
      }
      // Made with a key the operator replaced, or lost: the browser makes a new one, without asking
      // again — unless the permission was taken back, and then nothing is made.
      const current =
        held !== null && held.serverKey === pushing.serverKey
          ? held
          : asks.permission() === 'granted'
            ? await pushing.device.subscribe(pushing.serverKey)
            : null;
      if (current === null) {
        // Permission taken back since: what is left of it here is dropped, not tried on every load.
        await pushing.device.unsubscribe();
        storage.removeItem(PUSH_OWNER_KEY);
        return offOrBlocked(asks);
      }
      await api.subscribePush(requestOf(current, locale));
      told.current = locale;
      return 'on';
    };
    reconcile().then(
      (next) => {
        if (live) setStatus(next);
      },
      (error: unknown) => {
        if (!live) return;
        setStatus(offOrBlocked(asks));
        failed(error);
      },
    );
    return (): void => {
      live = false;
    };
    // Not on a language change: that would re-subscribe, and the effect below tells the server.
  }, [asks, notifier, device, keyAnswered, serverKey, userId]);

  useEffect(() => device?.onOpen(navigate), [device, navigate]);

  useEffect(() => {
    const previous = told.current;
    if (status !== 'on' || previous === null || previous === locale) return;
    told.current = locale;
    api.setLocale(locale).catch((error: unknown) => {
      // Not told: the next change, or the next load, tells it again.
      told.current = previous;
      failed(error);
    });
  }, [status, locale, api, failed]);

  const turnOn = useCallback((): void => {
    if (asks === null || storage === null) return;
    const pushing = device !== null && serverKey !== undefined ? { device, serverKey } : null;
    if (notifier === null && pushing === null) return;
    setStatus('working');
    const switchOn = async (): Promise<PushStatus> => {
      // Asked here when the page can ask; otherwise subscribing asks, as it always did.
      if (notifier !== null && (await notifier.request()) !== 'granted') return offOrBlocked(asks);
      if (pushing === null) {
        storage.setItem(PUSH_OWNER_KEY, userId);
        return 'on';
      }
      const made = await pushing.device.subscribe(pushing.serverKey);
      if (made === null) return offOrBlocked(asks);
      // Whose it is goes first, and goes again if the server refuses: what the browser is left
      // holding then has no owner, and the next load drops it.
      storage.setItem(PUSH_OWNER_KEY, userId);
      try {
        await api.subscribePush(requestOf(made, locale));
      } catch (error) {
        storage.removeItem(PUSH_OWNER_KEY);
        throw error;
      }
      told.current = locale;
      return 'on';
    };
    switchOn().then(setStatus, (error: unknown) => {
      setStatus(offOrBlocked(asks));
      failed(error);
    });
  }, [asks, notifier, device, serverKey, api, locale, storage, userId, failed]);

  const turnOff = useCallback((): void => {
    if (storage === null) return;
    setStatus('working');
    // The server first: refused, nothing changed. Past it nothing is sent, so the switch is off
    // whatever follows, and what is left here has no owner and goes on the next load.
    let stopped = false;
    const switchOff = async (): Promise<PushStatus> => {
      const held = device === null ? null : await device.current();
      if (held !== null) await api.unsubscribePush(held.endpoint);
      stopped = true;
      storage.removeItem(PUSH_OWNER_KEY);
      await device?.unsubscribe();
      return 'off';
    };
    switchOff().then(setStatus, (error: unknown) => {
      setStatus(stopped ? 'off' : 'on');
      failed(error);
    });
  }, [device, api, storage, failed]);

  const value = useMemo(
    () => ({
      controls:
        status === null
          ? null
          : { status, turnOn, turnOff, closedTab: device !== null && serverKey !== undefined },
      notifier,
    }),
    [status, turnOn, turnOff, notifier, device, serverKey],
  );
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>;
};
