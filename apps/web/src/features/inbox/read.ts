/**
 * Reading in the inbox (D-106): painted at once, then asked, and on a refusal read again from the
 * server and said why. One module, so every view of the inbox reads the same way.
 *
 * **Every view, both shapes.** The inbox is cached as many views under one prefix — All, Unread, each
 * category — some as pages a list scrolled through, and one page at a time. A row read in one is read
 * in all, so the paint walks the prefix and knows both shapes.
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import type { Notification, NotificationPage } from '@purlay/types';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { useToast } from '../../ui/toast';
import { useFeedPorts } from '../channel/feed-ports';
import { useWorkspace } from '../shell/workspace';

type Cached = NotificationPage | InfiniteData<NotificationPage>;

const readIn = (
  page: NotificationPage,
  read: (notification: Notification) => boolean,
  at: string,
): NotificationPage => ({
  ...page,
  data: page.data.map((n) => (n.readAt === null && read(n) ? { ...n, readAt: at } : n)),
});

/**
 * Marks these read in every cached view of the workspace's inbox. A row read stays in the Unread
 * view, muted, until the person looks again, so nothing jumps out from under the pointer.
 */
export const markLocally = (
  client: QueryClient,
  workspaceId: string,
  read: (notification: Notification) => boolean,
  at: string,
): void => {
  client.setQueriesData<Cached>({ queryKey: keys.notifications(workspaceId) }, (data) => {
    if (data === undefined) return data;
    return 'pages' in data
      ? { ...data, pages: data.pages.map((page) => readIn(page, read, at)) }
      : readIn(data, read, at);
  });
};

export interface InboxReads {
  /** Reads these notifications by id; nothing is asked when there are none. */
  readonly readIds: (ids: readonly string[]) => void;
  /** Reads the workspace's inbox up to `before`, and paints the ones on screen. */
  readonly readAll: (before: string, shown: ReadonlySet<string>) => void;
}

export const useInboxReads = (): InboxReads => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const { clock } = useFeedPorts();

  /** Paints, asks, and on a refusal asks for the list again and says why. */
  const read = (marked: (n: Notification) => boolean, ask: () => Promise<void>): void => {
    markLocally(client, workspace.id, marked, clock.now().toISOString());
    ask().catch((failure: unknown) => {
      void client.invalidateQueries({ queryKey: keys.notifications(workspace.id) });
      show({ message: `${t('inbox.readFailed')} ${describe(failure)}` });
    });
  };

  return {
    readIds: (ids): void => {
      if (ids.length === 0) return;
      const waiting = new Set(ids);
      read(
        (n) => waiting.has(n.id),
        () => api.readNotifications({ ids: [...ids] }),
      );
    },
    readAll: (before, shown): void => {
      read(
        (n) => shown.has(n.id),
        () => api.readNotifications({ workspaceId: workspace.id, before }),
      );
    },
  };
};
