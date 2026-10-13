/**
 * Whether a message is pinned in its channel, and pinning or letting it go (D-130).
 *
 * **Two layers, never mixed** (D-18). What the server says is the channel's pins (`GET …/pins`),
 * read once and kept current by `PINS_UPDATED`; it is never written to from here. What the person
 * has asked for and the server has not yet answered is an *intent*, held beside it for the channel
 * visit (`PinIntentsProvider`): a message is pinned as its intent says, and otherwise as the server
 * does. So a refusal only drops its own intent — whatever the list held, read or not, and whatever
 * anyone else changed meanwhile, stays as the server has it — and an answer read while a request is
 * on its way cannot take the painted change back.
 *
 * **Painted at once, said when refused**: an intent shows before the server answers; a refusal is
 * said, with Retry when trying again could help (CONTRIBUTING §1.9). One request a message at a
 * time: a second press while the first is on its way is not a second request. Only a member of the
 * channel can pin in it (D-130 §2), so for anyone else there is nothing to press.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Message, PinList } from '@purlay/types';
import { useApi } from '../../data/api-provider';
import { isTransient } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useToast } from '../../ui/toast';
import { useWorkspace } from '../shell/workspace';

/** What the person asked for a message, until the server's list says it too. */
interface Intent {
  readonly pinning: boolean;
  /** The message, so a pin asked for shows in the panel before the list has it. */
  readonly message: Message;
}

interface Intents {
  readonly byMessage: ReadonlyMap<string, Intent>;
  readonly put: (intent: Intent) => void;
  readonly drop: (messageId: string) => void;
  /** The intent for a message as it is now, not as the last render saw it. */
  readonly current: (messageId: string) => Intent | undefined;
}

const IntentsContext = createContext<Intents | null>(null);

/** The pins asked for in this channel visit. Without one — outside a channel — there is no Pin. */
export const PinIntentsProvider = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const [byMessage, setByMessage] = useState<ReadonlyMap<string, Intent>>(new Map());
  const latest = useRef(byMessage);
  latest.current = byMessage;
  const put = useCallback((intent: Intent): void => {
    const next = new Map(latest.current).set(intent.message.id, intent);
    latest.current = next;
    setByMessage(next);
  }, []);
  const drop = useCallback((messageId: string): void => {
    if (!latest.current.has(messageId)) return;
    const next = new Map(latest.current);
    next.delete(messageId);
    latest.current = next;
    setByMessage(next);
  }, []);
  const current = useCallback(
    (messageId: string): Intent | undefined => latest.current.get(messageId),
    [],
  );
  const value = useMemo(() => ({ byMessage, put, drop, current }), [byMessage, put, drop, current]);
  return createElement(IntentsContext.Provider, { value }, children);
};

/** Whether there is a channel visit to pin in — what the row asks before drawing Pin or its mark. */
export const useHasPinIntents = (): boolean => useContext(IntentsContext) !== null;

const useIntents = (): Intents => {
  const intents = useContext(IntentsContext);
  if (intents === null) throw new Error('pins were asked for outside a PinIntentsProvider');
  return intents;
};

/**
 * The channel's pins as the server has them. Kept current by the socket — a frame, a resubscription
 * — so they are not read again merely for being old.
 */
export const useServerPins = <T>(
  channelId: string,
  select: (pins: PinList) => T,
): ReturnType<typeof useQuery<PinList, Error, T>> => {
  const api = useApi();
  return useQuery({
    queryKey: keys.pins(channelId),
    queryFn: ({ signal }) => api.pins(channelId, signal),
    staleTime: Infinity,
    select,
  });
};

/** Whether the message is pinned: as asked, while that is on its way, and otherwise as the server says. */
export const useIsPinned = (message: Message): boolean => {
  const intent = useIntents().byMessage.get(message.id);
  const id = message.id;
  // Each row re-renders when its own answer changes, not whenever any pin does.
  const server = useServerPins(
    message.channelId,
    useCallback((pins: PinList) => pins.some((pin) => pin.message.id === id), [id]),
  );
  return intent?.pinning ?? server.data ?? false;
};

/** The channel's pins as the panel lists them: the server's, with what is asked for laid over them. */
export const useShownPins = (
  channelId: string,
): { readonly query: ReturnType<typeof useServerPins<PinList>>; readonly pins: PinList } => {
  const { byMessage } = useIntents();
  const query = useServerPins(
    channelId,
    useCallback((pins: PinList) => pins, []),
  );
  const pins = useMemo(() => {
    const server = query.data ?? [];
    const asked = [...byMessage.values()].filter(
      (intent) => intent.message.channelId === channelId,
    );
    const hidden = new Set(asked.filter((intent) => !intent.pinning).map((i) => i.message.id));
    const held = new Set(server.map((pin) => pin.message.id));
    const added = asked
      .filter((intent) => intent.pinning && !held.has(intent.message.id))
      .map((intent) => ({ message: intent.message, pinnedBy: null, pinnedAt: '' }));
    return [...added, ...server.filter((pin) => !hidden.has(pin.message.id))];
  }, [query.data, byMessage, channelId]);
  return { query, pins };
};

export interface PinControl {
  readonly pinned: boolean;
  /** Whether the person may change it: a member of the channel. */
  readonly canPin: boolean;
  /** A request for this message is on its way. */
  readonly pending: boolean;
  readonly toggle: () => void;
}

export const usePin = (message: Message): PinControl => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const intents = useIntents();
  const channels = useChannels(workspace.id);
  const pinned = useIsPinned(message);
  const pending = intents.byMessage.has(message.id);
  const canPin = channels.data?.find((channel) => channel.id === message.channelId)?.state != null;
  const key = keys.pins(message.channelId);

  /** Pinned now, by the intent or the server's list as they are at this moment. */
  const pinnedNow = (): boolean =>
    intents.current(message.id)?.pinning ??
    (client.getQueryData<PinList>(key) ?? []).some((pin) => pin.message.id === message.id);

  const change = (pinning: boolean): void => {
    // One request a message at a time, and none for what is already so.
    if (intents.current(message.id) !== undefined || pinnedNow() === pinning) return;
    intents.put({ pinning, message });
    (pinning ? api.pin(message.id) : api.unpin(message.id)).then(
      async () => {
        // Held until the server's list has been read after the change, so it never flickers back.
        await client.refetchQueries({ queryKey: key, exact: true });
        intents.drop(message.id);
      },
      (failure: unknown) => {
        intents.drop(message.id);
        show({
          message: `${t(pinning ? 'pins.failed' : 'pins.unpinFailed')} ${describe(failure)}`,
          ...(isTransient(failure)
            ? {
                actionLabel: t('common.retry'),
                // Asks again for what was asked, if it is still not so.
                onAction: (): void => {
                  change(pinning);
                },
              }
            : {}),
        });
      },
    );
  };

  return {
    pinned,
    canPin,
    pending,
    toggle: (): void => {
      change(!pinnedNow());
    },
  };
};
