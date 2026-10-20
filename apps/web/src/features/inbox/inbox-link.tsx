/**
 * "Inbox" on the rail: where the person finds what they were told (D-106).
 *
 * It carries no number of its own — the one numeric badge in the product is a channel's unread
 * mentions (`channel-row.tsx`), and a second count of the same thing would be noise. What it does
 * carry is a dot while any channel has something that needs the person (D-110): the same fact as
 * those badges, said once where the inbox is, so it can be seen with the sidebar closed. So in Deep
 * Work, when the badges draw nothing (D-15), neither does it: the inbox itself still lists everything.
 */
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { Tooltip } from '../../ui/tooltip';
import { useDeepWork } from '../shell/deep-work';
import { RailItemContent, railItemClasses } from '../shell/rail-item';
import { useWorkspace } from '../shell/workspace';

export const InboxLink = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { match } = useRoute();
  const channels = useChannels(workspace.id).data;
  const current = match.name === 'inbox';
  const quiet = useDeepWork().until !== null;
  const waiting =
    !quiet && (channels ?? []).some((channel) => (channel.state?.unreadMentionCount ?? 0) > 0);
  return (
    <Tooltip content={t('inbox.title')} side="right">
      <Link
        to="inbox"
        params={{ slug: workspace.slug }}
        {...(current ? { 'aria-current': 'page' as const } : {})}
        className={railItemClasses(current)}
      >
        <RailItemContent
          glyph="inbox"
          label={t('inbox.title')}
          {...(waiting ? { signal: { kind: 'dot' as const, words: t('sidebar.unread') } } : {})}
        />
      </Link>
    </Tooltip>
  );
};
