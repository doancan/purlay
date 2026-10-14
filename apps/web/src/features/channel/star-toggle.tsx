/**
 * Star, in a channel's header (#489, D-132): the channel kept in the sidebar's Starred section.
 * A member's, as the server holds it on their membership; for anyone else it is not there.
 *
 * Painted at once — the section changes before the server answers — and a refusal puts it back and
 * says why, with Retry when trying again could help (CONTRIBUTING §1.9). Its name stays "Star";
 * `aria-pressed` says whether it is.
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Channel } from '@purlay/types';
import { useApi } from '../../data/api-provider';
import { channelStarred } from '../../data/cache';
import { isTransient } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { families, keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { useToast } from '../../ui/toast';

/**
 * Each channel's star requests, one after another: a second click waits for the first, so the
 * server is asked in the order the person clicked and the last click is what stays. Per client,
 * so two screens of one page share the line and two pages never do.
 */
const lines = new WeakMap<QueryClient, Map<string, Promise<void>>>();

/** Star or let go of a channel, painted at once and put back when refused; null for a non-member. */
export const useStar = (channel: Channel): ((starred: boolean) => void) | null => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  if (channel.state === null) return null;
  const starredNow = (): boolean | undefined =>
    client
      .getQueriesData<Channel[]>({ queryKey: families.channels })
      .flatMap(([, list]) => list ?? [])
      .find((c) => c.id === channel.id)?.starred;

  const set = (starred: boolean): void => {
    // A list read already on its way would land after this paint and take it back: let it go.
    void client.cancelQueries({ queryKey: families.channels });
    channelStarred(client, channel.id, starred);
    const line = lines.get(client) ?? new Map<string, Promise<void>>();
    lines.set(client, line);
    const after = line.get(channel.id) ?? Promise.resolve();
    const done = after
      .then(() => api.star(channel.id, starred))
      .then(
        () => undefined,
        (failure: unknown) => {
          channelStarred(client, channel.id, starred, true);
          show({
            message: `${t(starred ? 'star.failed' : 'star.unstarFailed')} ${describe(failure)}`,
            ...(isTransient(failure)
              ? {
                  actionLabel: t('common.retry'),
                  // Asks again for what was asked, only if it is still not so.
                  onAction: (): void => {
                    if (starredNow() !== starred) set(starred);
                  },
                }
              : {}),
          });
        },
      )
      .finally(() => {
        if (line.get(channel.id) === done) {
          line.delete(channel.id);
          // The last of the line has its answer: the server's list is the one that stays.
          void client.invalidateQueries({ queryKey: keys.channels(channel.workspaceId) });
        }
      });
    line.set(channel.id, done);
  };
  return set;
};

/** On a wide window: its own button. On a narrow one it is in the header's menu (`panel-controls.tsx`). */
export const StarToggle = ({
  channel,
}: {
  readonly channel: Channel;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const set = useStar(channel);
  if (set === null) return null;
  return (
    <IconButton
      label={t('star.label')}
      glyph="star"
      aria-pressed={channel.starred}
      className={cn('max-narrow:hidden', channel.starred && 'text-accent-text')}
      onClick={() => {
        set(!channel.starred);
      }}
    />
  );
};
