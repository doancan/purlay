/**
 * Showing the notice an open tab in the background owes its person (D-148). Loaded only the first
 * time there is one to show, so a page nobody leaves never pays for it.
 *
 * Who and where, never what was written — a desktop notice is read over a shoulder as a lock screen
 * is (D-126 §2): the title is the place, the body the inbox's own words for why. A click brings the
 * window to the front and opens what the inbox row would.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Channel, Notification, Workspace } from '@purlay/types';
import type { Api } from '../../data/api';
import { keys } from '../../data/keys';
import type { Translate } from '../../i18n/types';
import { href } from '../../router/routes';
import { targetOf, whyOf } from '../inbox/why';
import type { Notifier } from '../push/notifier';
import { placeOf } from '../shell/tab-title';
import { newestFor, summaryTag, tagOf, type Plan } from './decide';

export interface Telling {
  readonly plan: Exclude<Plan, { readonly kind: 'none' }>;
  readonly client: QueryClient;
  readonly api: Api;
  readonly workspace: Pick<Workspace, 'id' | 'slug' | 'name'>;
  readonly me: string;
  readonly channels: readonly Channel[];
  readonly t: Translate;
  readonly notices: Notifier;
  /** Goes to a path in this tab, by the page's own router. */
  readonly open: (path: string) => void;
}

/** The newest page of the inbox, asked now: the badge rose, so something new is on it. */
const newest = async ({ client, api, workspace }: Telling): Promise<readonly Notification[]> => {
  try {
    const page = await client.query({
      queryKey: keys.newestNotifications(workspace.id),
      queryFn: ({ signal }) => api.notifications(workspace.id, {}, signal),
      staleTime: 0,
    });
    return page.data;
  } catch {
    // Not read: the notice still goes, saying where and not why — the interruption is the point,
    // and the inbox says the rest when the person comes.
    return [];
  }
};

export const tell = async (telling: Telling): Promise<void> => {
  const { plan, workspace, t, notices, open, me } = telling;
  if (plan.kind === 'many') {
    notices.show({
      title: workspace.name,
      body: t('alerts.many', { count: plan.count }),
      tag: summaryTag(workspace.id),
      onOpen: () => {
        open(href('inbox', { slug: workspace.slug }));
      },
    });
    return;
  }
  const { channelId } = plan;
  const channel = telling.channels.find((c) => c.id === channelId);
  const said = newestFor(await newest(telling), channelId, me);
  notices.show({
    title: (channel === undefined ? null : placeOf(t, channel, me)) ?? workspace.name,
    body: said === null ? t('alerts.waiting') : whyOf(t, said, channel, me),
    tag: tagOf(channelId),
    onOpen: () => {
      open(
        said === null
          ? href('channel', { slug: workspace.slug, channelId })
          : targetOf(workspace.slug, said),
      );
    },
  });
};
