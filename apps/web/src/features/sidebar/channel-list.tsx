/**
 * The Channels section: the channels the person is in, and the two ways to get another —
 * make one, or find one that already exists.
 *
 * It owns the channel list's states (`UX.md` §8): skeleton rows while it loads, a failure
 * that says so and offers Retry, and — when the person is in no channel at all — an empty
 * section that says what to do next. The dialogs live here, beside the buttons that open
 * them, so focus returns to the button that was pressed.
 */
import { useState } from 'react';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { useWorkspace } from '../shell/workspace';
import { BrowseChannelsDialog } from './browse-channels-dialog';
import { ChannelRow } from './channel-row';
import { NewChannelDialog } from './new-channel-dialog';
import { joinedChannels, starredChannels } from './ordering';
import { SectionEmpty, SectionError, SectionLoading } from './section-state';

export const ChannelList = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const { match } = useRoute();
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const currentId = match.name === 'channel' ? match.params.channelId : null;
  const mine = joinedChannels(channels.data ?? []);
  // In no channel at all is the empty state; in channels that are all starred is not (D-132).
  const none = mine.length === 0 && starredChannels(channels.data ?? []).length === 0;

  return (
    <nav aria-label={t('sidebar.channels')} className="flex flex-col">
      {/* Always shown, in the section's quiet tone: a way in that appears only under a pointer is one
      a newcomer never finds, and the tooltips say what each glyph is. */}
      <div className="flex items-center justify-between pl-2">
        <h2 className="py-1 text-label text-nav-ink-muted">{t('sidebar.channels')}</h2>
        <div className="flex">
          <IconButton
            label={t('sidebar.browse')}
            glyph="search"
            size="nav"
            onClick={() => {
              setBrowsing(true);
            }}
          />
          <IconButton
            label={t('sidebar.newChannel')}
            glyph="add"
            size="nav"
            onClick={() => {
              setCreating(true);
            }}
          />
        </div>
      </div>
      {channels.isPending ? (
        <SectionLoading label={t('state.channels.loading')} />
      ) : channels.isError ? (
        <SectionError
          title={t('state.channels.error.title')}
          body={t('state.channels.error.body')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void channels.refetch();
          }}
        />
      ) : none ? (
        <SectionEmpty
          title={t('state.channels.empty.title')}
          body={t('state.channels.empty.body')}
          action={
            <Button
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('sidebar.newChannel')}
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col">
          {mine.map((channel) => (
            <li key={channel.id}>
              <ChannelRow
                slug={workspace.slug}
                channel={channel}
                glyph={channel.type === 'private' ? 'private-channel' : 'channel'}
                current={channel.id === currentId}
                unread={(channel.state?.unreadCount ?? 0) > 0}
                mentions={channel.state?.unreadMentionCount ?? 0}
                incident={channel.incident}
                muted={channel.notificationLevel === 'none'}
              >
                {channel.name}
              </ChannelRow>
            </li>
          ))}
        </ul>
      )}
      <NewChannelDialog open={creating} onOpenChange={setCreating} />
      <BrowseChannelsDialog open={browsing} onOpenChange={setBrowsing} />
    </nav>
  );
};
