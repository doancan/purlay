/**
 * Notifications on this device (#78, D-126): what turns them on and off, and what keeps a device
 * that has them on told.
 *
 * - **Offered only where it can work:** a browser with push and storage to remember whose it is,
 *   and a server whose operator switched it on (`GET /api/push/key`). Anywhere else nothing is
 *   drawn, rather than a switch that fails; a key that could not be read is said.
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

/** Who turned push on in this browser. A personal key: signing out forgets it (`browser-storage.ts`). */
export const PUSH_OWNER_KEY = 'purlay.push.owner';

/** The device a test hands over; `undefined` is the browser's, `null` a browser with no push. */
export const PushDeviceContext = createContext<PushDevice | null | undefined>(undefined);

/**
 * `blocked`: the person told the browser no, and only its site settings can undo that.
 * `working`: a change is on its way, and the switch waits for it.
 */
type PushStatus = 'off' | 'on' | 'blocked' | 'working';

export interface PushControls {
  readonly status: PushStatus;
  readonly turnOn: () => void;
  readonly turnOff: () => void;
}

const PushContext = createContext<PushControls | null>(null);

/** The switch, or `null` where none is offered: no push in this browser or on this server. */
export const usePushControls = (): PushControls | null => useContext(PushContext);

const requestOf = (held: DeviceSubscription, locale: PushLocale): PushSubscribeRequest => ({
  endpoint: held.endpoint,
  keys: { p256dh: held.p256dh, auth: held.auth },
  locale,
});

const offOrBlocked = (device: PushDevice): PushStatus =>
  device.permission() === 'denied' ? 'blocked' : 'off';

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
  const key = useQuery({
    queryKey: keys.pushKey,
    queryFn: ({ signal }) => api.pushKey(signal),
    enabled: device !== null && storage !== null,
    staleTime: Infinity,
  });
  // `null`: the operator has push off, and nothing is offered.
  const serverKey = key.data?.publicKey ?? undefined;
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

  // On load: honour the subscription this browser holds only for its owner, and re-send it.
  useEffect(() => {
    if (device === null || storage === null || serverKey === undefined) return;
    let live = true;
    const reconcile = async (): Promise<PushStatus> => {
      const held = await device.current();
      if (held === null) return offOrBlocked(device);
      if (storage.getItem(PUSH_OWNER_KEY) !== userId) {
        await device.unsubscribe();
        return offOrBlocked(device);
      }
      // Made with a key the operator replaced: the browser makes a new one, without asking again.
      const current = held.serverKey === serverKey ? held : await device.subscribe(serverKey);
      if (current === null) {
        // Permission taken back since: what is left of it here is dropped, not tried on every load.
        await device.unsubscribe();
        storage.removeItem(PUSH_OWNER_KEY);
        return offOrBlocked(device);
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
        setStatus(offOrBlocked(device));
        failed(error);
      },
    );
    return (): void => {
      live = false;
    };
    // Not on a language change: that would re-subscribe, and the effect below tells the server.
  }, [device, serverKey, userId]);

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
    if (device === null || storage === null || serverKey === undefined) return;
    setStatus('working');
    const subscribe = async (): Promise<PushStatus> => {
      const made = await device.subscribe(serverKey);
      if (made === null) return offOrBlocked(device);
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
    subscribe().then(setStatus, (error: unknown) => {
      setStatus(offOrBlocked(device));
      failed(error);
    });
  }, [device, serverKey, api, locale, storage, userId, failed]);

  const turnOff = useCallback((): void => {
    if (device === null || storage === null) return;
    setStatus('working');
    // The server first: refused, nothing changed. Past it nothing is sent, so the switch is off
    // whatever follows, and what is left here has no owner and goes on the next load.
    let stopped = false;
    const unsubscribe = async (): Promise<PushStatus> => {
      const held = await device.current();
      if (held !== null) await api.unsubscribePush(held.endpoint);
      stopped = true;
      storage.removeItem(PUSH_OWNER_KEY);
      await device.unsubscribe();
      return 'off';
    };
    unsubscribe().then(setStatus, (error: unknown) => {
      setStatus(stopped ? 'off' : 'on');
      failed(error);
    });
  }, [device, api, storage, failed]);

  const controls = useMemo(
    () => (status === null ? null : { status, turnOn, turnOff }),
    [status, turnOn, turnOff],
  );
  return <PushContext.Provider value={controls}>{children}</PushContext.Provider>;
};
