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
import { joinedChannels } from './ordering';
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

  return (
    <nav aria-label={t('sidebar.channels')} className="flex flex-col gap-1">
      <div className="flex items-center justify-between pl-2">
        <h2 className="text-label text-ink-muted">{t('sidebar.channels')}</h2>
        <div className="flex">
          <IconButton
            label={t('sidebar.browse')}
            glyph="search"
            onClick={() => {
              setBrowsing(true);
            }}
          />
          <IconButton
            label={t('sidebar.newChannel')}
            glyph="add"
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
      ) : mine.length === 0 ? (
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
        <ul className="flex flex-col gap-1">
          {mine.map((channel) => (
            <li key={channel.id}>
              <ChannelRow
                slug={workspace.slug}
                channelId={channel.id}
                glyph={channel.type === 'private' ? 'private-channel' : 'channel'}
                mono
                current={channel.id === currentId}
                unread={(channel.state?.unreadCount ?? 0) > 0}
                mentions={channel.state?.unreadMentionCount ?? 0}
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
