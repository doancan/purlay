/**
 * Save, beside React on a message (#484, D-128): a message kept to come back to, on any message one
 * can read.
 *
 * **Two layers, never mixed** (D-18), as Pin holds them (`features/pins/use-pin.ts`). What the server
 * says is the workspace's list of saves (`GET …/saved/ids`), read once and kept by the cache; another
 * tab's change arrives as `SAVED_UPDATED`, which reads it again. It is never written to from here.
 * What the person has asked and the server has not yet answered is an *intent*, held beside it for
 * the workspace (`SaveIntentsProvider`): a message is saved as its intent says, and otherwise as the
 * server does. So a refusal drops only its own intent — another save, or what another tab did, stays
 * as the server has it — and a list read while a request is on its way cannot take the mark back.
 *
 * **Painted at once, said when refused**: the mark changes before the server answers; a refusal is
 * said, with Retry only when trying again could help (CONTRIBUTING §1.9). One request a message at a
 * time: a press while one is on its way is not a second request.
 */
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { Message, SavedIds } from '@purlay/types';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Icon } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { isTransient } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { useToast } from '../../ui/toast';
import { useWorkspaceIfAny } from '../shell/workspace';

const idsKey = (workspaceId: string): readonly unknown[] => [...keys.saved(workspaceId), 'ids'];

/** What the person asked for each message — kept, or let go — until the server's list says it too. */
interface Intents {
  readonly byMessage: ReadonlyMap<string, boolean>;
  readonly put: (messageId: string, keeping: boolean) => void;
  readonly drop: (messageId: string) => void;
  /** The intent for a message as it is now, not as the last render saw it. */
  readonly current: (messageId: string) => boolean | undefined;
}

const IntentsContext = createContext<Intents | null>(null);

/** The saves asked for in this workspace. Without one there is no Save to press. */
export const SaveIntentsProvider = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const [byMessage, setByMessage] = useState<ReadonlyMap<string, boolean>>(new Map());
  const latest = useRef(byMessage);
  latest.current = byMessage;
  const put = useCallback((messageId: string, keeping: boolean): void => {
    const next = new Map(latest.current).set(messageId, keeping);
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
    (messageId: string): boolean | undefined => latest.current.get(messageId),
    [],
  );
  const value = useMemo(() => ({ byMessage, put, drop, current }), [byMessage, put, drop, current]);
  return createElement(IntentsContext.Provider, { value }, children);
};

/** Which messages the person has saved in the workspace, as the server says. */
const useSavedIds = (workspaceId: string): UseQueryResult<SavedIds> => {
  const api = useApi();
  return useQuery({
    queryKey: idsKey(workspaceId),
    queryFn: ({ signal }) => api.savedIds(workspaceId, signal),
  });
};

/** Nothing outside a workspace: what is saved belongs to one. */
export const SaveToggle = ({
  message,
}: {
  readonly message: Message;
}): React.JSX.Element | null => {
  const scope = useWorkspaceIfAny();
  const intents = useContext(IntentsContext);
  return scope === null || intents === null ? null : (
    <Toggle message={message} workspaceId={scope.workspace.id} intents={intents} />
  );
};

const Toggle = ({
  message,
  workspaceId,
  intents,
}: {
  readonly message: Message;
  readonly workspaceId: string;
  readonly intents: Intents;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const ids = useSavedIds(workspaceId);
  const key = idsKey(workspaceId);
  const intent = intents.byMessage.get(message.id);
  const saved = intent ?? (ids.data ?? []).some((entry) => entry.messageId === message.id);

  /** Saved now, by the intent or the server's list as they are at this moment. */
  const savedNow = (): boolean =>
    intents.current(message.id) ??
    (client.getQueryData<SavedIds>(key) ?? []).some((entry) => entry.messageId === message.id);

  /** The list with this message's confirmed change in it, and nothing else touched. */
  const confirmed = (held: SavedIds, keeping: boolean): SavedIds => {
    const without = held.filter((entry) => entry.messageId !== message.id);
    return keeping
      ? [{ messageId: message.id, channelId: message.channelId, state: 'in_progress' }, ...without]
      : without;
  };

  const change = (keeping: boolean): void => {
    // One request a message at a time, and none for what is already so.
    if (intents.current(message.id) !== undefined || savedNow() === keeping) return;
    intents.put(message.id, keeping);
    (keeping ? api.saveMessage(message.id) : api.unsaveMessage(message.id)).then(
      async () => {
        // The mark holds until the list has been read again with the change in it. A read that
        // fails is not the save failing: the change the server confirmed is set on the list as it
        // is, and the next read brings the rest.
        try {
          await client.refetchQueries({ queryKey: key, exact: true }, { throwOnError: true });
        } catch {
          client.setQueryData<SavedIds>(key, (held) => confirmed(held ?? [], keeping));
        }
        intents.drop(message.id);
        // The other views of the saves — the Saved list, if it is open — are read again too.
        void client.invalidateQueries({
          queryKey: keys.saved(workspaceId),
          predicate: (query) => query.queryKey.at(-1) !== 'ids',
        });
      },
      (failure: unknown) => {
        intents.drop(message.id);
        show({
          message: `${t(keeping ? 'saved.failed' : 'saved.unsaveFailed')} ${describe(failure)}`,
          ...(isTransient(failure)
            ? {
                actionLabel: t('common.retry'),
                // Asks again for what was asked, if it is still not so.
                onAction: (): void => {
                  change(keeping);
                },
              }
            : {}),
        });
      },
    );
  };

  return (
    <button
      type="button"
      aria-pressed={saved}
      aria-busy={intent !== undefined}
      aria-label={t('saved.save')}
      title={t(saved ? 'saved.remove' : 'saved.save')}
      className={cn(
        'inline-flex h-control aspect-square items-center justify-center rounded-sm hover:bg-surface-100',
        saved ? 'text-accent-text' : 'text-ink-muted hover:text-ink',
      )}
      onClick={() => {
        change(!savedNow());
      }}
    >
      <Icon name={saved ? 'saved' : 'save'} />
    </button>
  );
};
