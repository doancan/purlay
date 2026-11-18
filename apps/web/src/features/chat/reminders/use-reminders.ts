/**
 * A person's reminders on messages, as the screens use them: which message has one, and setting,
 * changing and cancelling it.
 *
 * **Whether to draw any of it.** The server advertises `capabilities.messageReminders` on the public
 * `GET /api/client`, which the browser never asks (D-248). The flag is true exactly where chat runs
 * (`API.md` §2), and the session already says which modules run, so that is the question asked here:
 * without chat nothing of reminders is drawn.
 *
 * **Server state, laid over for a moment.** What the server says is the workspace's list of pending
 * reminders (`GET …/reminders`), kept by the cache and read again on `REMINDERS_UPDATED`. A change is
 * painted into that list at once and asked of the server; a refusal puts back what the list held for
 * that message and says so, with Retry only when trying again could help (CONTRIBUTING §1.9).
 */
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Message, MessageReminder, MessageReminderList } from '@purlay/types';
import { useApi } from '../../../data/api-provider';
import { captureAccess } from '../../../data/access-revision';
import { isTransient } from '../../../data/errors';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { useToast } from '../../../ui/toast';
import { useRunsIfAny } from '../../session/session';
import { useFeedPorts } from '../channel/feed-ports';
import { useWorkspaceIfAny } from '../../shell/workspace';

/** Whether this server can remind: it can wherever chat runs (see above). */
export const useRemindersAvailable = (): boolean => useRunsIfAny('chat');

type Read = UseQueryResult<MessageReminderList>;

/** The workspace's reminders; asked again on opening, and on focus where `fresh` says the screen shows them. */
export const useReminders = (
  workspaceId: string,
  { enabled = true, fresh = false }: { readonly enabled?: boolean; readonly fresh?: boolean } = {},
): Read => {
  const api = useApi();
  return useQuery({
    queryKey: keys.reminders(workspaceId),
    queryFn: ({ signal }) => api.listReminders(workspaceId, signal),
    enabled,
    ...(fresh ? { refetchOnMount: 'always', refetchOnWindowFocus: 'always' } : {}),
  });
};

/** The caller's reminder on a message, if the list holds one; nothing where reminders are not drawn. */
export const useReminderOf = (message: Message): MessageReminder | undefined => {
  const api = useApi();
  const scope = useWorkspaceIfAny();
  const available = useRemindersAvailable();
  const workspaceId = scope?.workspace.id ?? '';
  const read = useQuery({
    queryKey: keys.reminders(workspaceId),
    queryFn: ({ signal }) => api.listReminders(workspaceId, signal),
    enabled: available && scope !== null,
    select: (list) => list.find((reminder) => reminder.message.id === message.id) ?? null,
  });
  return read.data ?? undefined;
};

/** The list with one message's reminder put, replaced or taken out, soonest first. */
const withReminder = (
  list: MessageReminderList,
  messageId: string,
  reminder: MessageReminder | undefined,
): MessageReminderList =>
  [...list.filter((held) => held.message.id !== messageId), ...(reminder ? [reminder] : [])].sort(
    (a, b) => Date.parse(a.remindAt) - Date.parse(b.remindAt),
  );

/** One message's entry in the list as the cache holds it, changed; a list not read yet is left unwritten. */
const paint = (
  client: QueryClient,
  key: readonly unknown[],
  messageId: string,
  reminder: MessageReminder | undefined,
): void => {
  client.setQueryData<MessageReminderList>(key, (held) =>
    held === undefined ? undefined : withReminder(held, messageId, reminder),
  );
};

export interface ReminderActions {
  readonly set: (message: Message, remindAt: string) => void;
  readonly cancel: (message: Message) => void;
}

/** Set, change and cancel, for a screen in a workspace; null outside one or where reminders are not drawn. */
export const useReminderActions = (): ReminderActions | null => {
  const { t, format } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const clock = useFeedPorts().clock;
  const scope = useWorkspaceIfAny();
  const available = useRemindersAvailable();
  if (scope === null || !available) return null;
  const key = keys.reminders(scope.workspace.id);

  /**
   * Paints `next` for the message, asks, and reads the list again either way. A refusal puts back
   * what the list held for this message alone — another message's change, or what another device
   * did, stays as the server has it — and says what failed.
   */
  const change = (
    message: Message,
    next: MessageReminder | undefined,
    ask: () => Promise<unknown>,
    failed: 'reminders.setFailed' | 'reminders.cancelFailed',
    retry: () => void,
    done: () => void,
  ): void => {
    const stillCurrent = captureAccess(client, key);
    // A read already on its way would answer with the list as it was and paint the change away.
    void client.cancelQueries({ queryKey: key, exact: true }).then(() => {
      const before = client
        .getQueryData<MessageReminderList>(key)
        ?.find((held) => held.message.id === message.id);
      paint(client, key, message.id, next);
      ask().then(
        () => {
          if (!stillCurrent()) return;
          void client.invalidateQueries({ queryKey: key, exact: true });
          done();
        },
        (failure: unknown) => {
          if (!stillCurrent()) return;
          paint(client, key, message.id, before);
          void client.invalidateQueries({ queryKey: key, exact: true });
          show({
            message: `${t(failed)} ${describe(failure)}`,
            ...(isTransient(failure) ? { actionLabel: t('common.retry'), onAction: retry } : {}),
          });
        },
      );
    });
  };

  const actions: ReminderActions = {
    set: (message, remindAt) => {
      change(
        message,
        {
          // Until the server's own is read back, the message's id stands for the reminder's.
          id: message.id,
          message,
          remindAt,
          createdAt: clock.now().toISOString(),
        },
        () => api.setMessageReminder(message.id, remindAt),
        'reminders.setFailed',
        () => {
          actions.set(message, remindAt);
        },
        () => {
          show({ message: t('reminders.set', { when: format.absolute(remindAt) }) });
        },
      );
    },
    cancel: (message) => {
      change(
        message,
        undefined,
        () => api.cancelMessageReminder(message.id),
        'reminders.cancelFailed',
        () => {
          actions.cancel(message);
        },
        () => undefined,
      );
    },
  };
  return actions;
};
