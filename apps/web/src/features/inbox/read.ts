/**
 * Reading in the inbox, wherever it is shown — the page and the panel (D-106, D-208): painted at
 * once, then asked, and on a refusal read again from the server and said why.
 *
 * **Every view, both shapes.** The inbox is cached as many views under one prefix — All, Unread, each
 * category, the panel's one page — some as pages a list scrolled through, the panel's as one page. A
 * row read in one is read in all, so the paint walks the prefix and knows both shapes.
 *
 * **Never painted back.** A frame can have asked for the inbox again a moment before the person read
 * a row; that answer, left to land, would paint the row unread again under the pointer. So what is
 * in flight is cancelled before the paint, and the paint is laid again once the server has answered
 * — anything read again in between landed on the server's old state, and the row is read now.
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import type { Notification, NotificationPage } from '@purlay/types';
import { PAGE_LIMIT } from '@purlay/types';
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

  const read = (marked: (n: Notification) => boolean, ask: () => Promise<void>): void => {
    const prefix = keys.notifications(workspace.id);
    const at = clock.now().toISOString();
    // Synchronously, before the paint: an answer already on its way must not land on top of it.
    void client.cancelQueries({ queryKey: prefix });
    markLocally(client, workspace.id, marked, at);
    ask().then(
      () => {
        markLocally(client, workspace.id, marked, at);
      },
      (failure: unknown) => {
        void client.invalidateQueries({ queryKey: prefix });
        show({ message: `${t('inbox.readFailed')} ${describe(failure)}` });
      },
    );
  };

  return {
    readIds: (ids): void => {
      if (ids.length === 0) return;
      const waiting = new Set(ids);
      // The server takes at most a page of ids at once; a thread gathering more is read in several.
      const chunks: string[][] = [];
      for (let at = 0; at < ids.length; at += PAGE_LIMIT.max) {
        chunks.push(ids.slice(at, at + PAGE_LIMIT.max));
      }
      read(
        (n) => waiting.has(n.id),
        async () => {
          await Promise.all(chunks.map((chunk) => api.readNotifications({ ids: chunk })));
        },
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
