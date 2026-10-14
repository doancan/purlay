/**
 * Star, in a channel's header (#489, D-132): the channel kept in the sidebar's Starred section.
 * A member's, as the server holds it on their membership; for anyone else it is not there.
 *
 * Painted at once — the section changes before the server answers — and a refusal puts it back and
 * says why, with Retry when trying again could help (CONTRIBUTING §1.9). Its name stays "Star";
 * `aria-pressed` says whether it is.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { Channel } from '@purlay/types';
import { useApi } from '../../data/api-provider';
import { channelStarred } from '../../data/cache';
import { isTransient } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { useToast } from '../../ui/toast';

/** Star or let go of a channel, painted at once and put back when refused; null for a non-member. */
export const useStar = (channel: Channel): ((starred: boolean) => void) | null => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  if (channel.state === null) return null;
  const set = (starred: boolean): void => {
    channelStarred(client, channel.id, starred);
    api.star(channel.id, starred).catch((failure: unknown) => {
      channelStarred(client, channel.id, starred, true);
      show({
        message: `${t(starred ? 'star.failed' : 'star.unstarFailed')} ${describe(failure)}`,
        ...(isTransient(failure)
          ? {
              actionLabel: t('common.retry'),
              onAction: (): void => {
                set(starred);
              },
            }
          : {}),
      });
    });
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
