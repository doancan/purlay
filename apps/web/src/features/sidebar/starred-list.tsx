/**
 * The Starred section (#489, D-132): the channels the person keeps at hand, above Channels and out
 * of it, by name. Not there until something is starred — an empty section would only be noise —
 * and it shares the channel list's states, so it says nothing while that one says what is wrong.
 */
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useRoute } from '../../router/router-provider';
import { useWorkspace } from '../shell/workspace';
import { ChannelRow } from './channel-row';
import { starredChannels } from './ordering';

export const StarredList = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const { match } = useRoute();
  const currentId = match.name === 'channel' ? match.params.channelId : null;
  const starred = starredChannels(channels.data ?? []);
  if (starred.length === 0) return null;
  return (
    <nav aria-label={t('sidebar.starred')} className="flex flex-col">
      <div className="flex items-center px-2 py-1">
        <h2 className="text-label text-nav-ink-muted">{t('sidebar.starred')}</h2>
      </div>
      <ul className="flex flex-col">
        {starred.map((channel) => (
          <li key={channel.id}>
            <ChannelRow
              slug={workspace.slug}
              channelId={channel.id}
              glyph={channel.type === 'private' ? 'private-channel' : 'channel'}
              current={channel.id === currentId}
              unread={(channel.state?.unreadCount ?? 0) > 0}
              mentions={channel.state?.unreadMentionCount ?? 0}
            >
              {channel.name}
            </ChannelRow>
          </li>
        ))}
      </ul>
    </nav>
  );
};
