/** Where a draft, a sent message or a scheduled one is: the channel, and "in a thread" for a reply. */
import type { Channel } from '@purlay/types';
import { useI18n } from '../../../i18n/i18n-provider';
import { useChannelTitle } from '../channel/channel-header';

export const Place = ({
  channel,
  thread,
}: {
  readonly channel: Channel;
  readonly thread: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const title = useChannelTitle(channel);
  return (
    <span className="flex items-baseline gap-2 text-label text-ink-muted">
      <span className="min-w-0 truncate font-medium text-ink">{title}</span>
      {thread && <span className="shrink-0">· {t('drafts.inThread')}</span>}
    </span>
  );
};
