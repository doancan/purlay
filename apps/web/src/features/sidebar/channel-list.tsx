/**
 * The Channels section: the channels the person is in, and the two ways to get another —
 * make one, or find one that already exists.
 *
 * It owns the channel list's states (`UX.md` §8): skeleton rows while it loads, a failure
 * that says so and offers Retry, and — when the person is in no channel at all — an empty
 * section that says what to do next. The dialogs live here, beside the buttons that open
 * them, so focus returns to the button that was pressed.
 *
 * The person arranges it (D-195): the heading folds it, leaving what needs a look; they may have it
 * only-unread, without muted channels, and by activity instead of by name.
 */
import { useState } from 'react';
import { useDeferred } from '../../app/deferred-door';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { useWorkspace } from '../shell/workspace';
import { ChannelRow } from './channel-row';
import { joinableChannels, joinedChannels, starredChannels } from './ordering';
import { useSidebarPreferences } from './preferences-context';
import { rowOf, shownRows, withToggled } from './preferences';
import { SectionHeading } from './section-heading';
import { SectionEmpty, SectionError, SectionLoading } from './section-state';

export const ChannelList = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const { match } = useRoute();
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  // Both dialogs are in the deferred chunk (D-163).
  const deferred = useDeferred([creating, setCreating], [browsing, setBrowsing]);
  const currentId = match.name === 'channel' ? match.params.channelId : null;
  const { preferences, change } = useSidebarPreferences();
  const mine = joinedChannels(channels.data ?? [], preferences.channelOrder);
  const collapsed = preferences.collapsed.includes('channels');
  const shown = shownRows(
    mine.map((channel) => ({ ...rowOf(channel), channel })),
    {
      collapsed,
      unreadOnly: preferences.unreadOnly,
      hideMuted: preferences.hideMuted,
      currentId,
    },
  );
  // In no channel at all is the empty state; in channels that are all starred is not (D-132).
  const none = mine.length === 0 && starredChannels(channels.data ?? []).length === 0;
  // In none, but with public ones to join (an invited member arrives so): "create the first" would be untrue.
  const joinable = none && joinableChannels(channels.data ?? []).length > 0;

  return (
    <nav aria-label={t('sidebar.channels')} className="flex flex-col">
      {/* Always shown, in the section's quiet tone: a way in that appears only under a pointer is one
      a newcomer never finds, and the tooltips say what each glyph is. */}
      <SectionHeading
        controls="sidebar-list-channels"
        collapsed={collapsed}
        onToggle={() => {
          change({ collapsed: withToggled(preferences.collapsed, 'channels') });
        }}
        actions={
          <>
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
          </>
        }
      >
        {t('sidebar.channels')}
      </SectionHeading>
      <div id="sidebar-list-channels">
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
            title={joinable ? t('state.channels.unjoined.title') : t('state.channels.empty.title')}
            body={joinable ? t('state.channels.unjoined.body') : t('state.channels.empty.body')}
            action={
              joinable ? (
                <Button
                  onClick={() => {
                    setBrowsing(true);
                  }}
                >
                  {t('sidebar.browse')}
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    setCreating(true);
                  }}
                >
                  {t('sidebar.newChannel')}
                </Button>
              )
            }
          />
        ) : (
          <>
            <ul className="flex flex-col">
              {shown.map(({ channel }) => (
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
            {/* Said once, where the asking was done, so an empty list is not mistaken for a failed one. */}
            {mine.length > 0 && shown.length === 0 && !collapsed ? (
              <p className="px-2 py-1 text-caption text-nav-ink-muted">
                {preferences.unreadOnly ? t('sidebar.caughtUp') : t('sidebar.filtered')}
              </p>
            ) : null}
          </>
        )}
      </div>
      {deferred !== null && (
        <>
          <deferred.NewChannelDialog open={creating} onOpenChange={setCreating} />
          <deferred.BrowseChannelsDialog open={browsing} onOpenChange={setBrowsing} />
        </>
      )}
    </nav>
  );
};
