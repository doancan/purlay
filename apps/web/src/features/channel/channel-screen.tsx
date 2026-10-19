/**
 * A channel: its header, its messages and the composer, with the three states every view
 * has (`UX.md` §8) — loading, empty, failed — and the one more a channel has: not found.
 *
 * **A channel is re-opened, not updated**: the inner view is keyed by the channel, so
 * everything that belongs to *this visit* — which message the read position was at when it
 * opened (the unread marker, frozen for as long as the channel stays open and not moved by the
 * reading it causes), the focused row, the scroll state — starts fresh when the person
 * moves to another channel and again when they come back.
 *
 * **A thread opens beside it** (D-122): the channel's column and the thread panel share one row,
 * and the panel covers the column on a narrow window. Which thread is open belongs to this visit,
 * like the rest, unless the address names one. The channel's files open in the same place, in the
 * thread's stead (D-129, `side-panel.tsx`).
 *
 * **A link to a message opens the channel around it** (`?message=`, D-149). Unlike `?thread=` it is
 * read on every change of address, not once: Go to message in the pins panel names another message
 * of the same channel, and the feed is opened again around it. A link the person cannot follow says
 * so in one sentence over the channel, which opens as it is.
 *
 * A channel the person can see but has not joined has no read position and cannot be
 * written to; it shows its messages and a way to join, in place of the composer, so a link
 * to a public channel is useful before they are in it.
 */
import { useDescribeFailure } from '../../data/failure';
import { useCallback, useEffect, useState } from 'react';
import type { Channel } from '@purlay/types';
import { useActions } from '../../data/actions-provider';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { EmptyState } from '../../ui/states';
import { EditingProvider } from '../messages/editing';
import { Composer } from '../composer/composer';
import { href, messageInSearch, threadInSearch } from '../../router/routes';
import { Icon } from '../../components/icon';
import { useRoute } from '../../router/router-provider';
import { rememberChannel } from '../questions/last-channel';
import { ScreenBar } from '../shell/screen-bar';
import { useWorkspace } from '../shell/workspace';
import { useGone } from '../../realtime/realtime-provider';
import { ChannelHeader, useChannelTitle } from './channel-header';
import { MessageFeed } from './message-feed';
import { ThreadsProvider, useOpenThread } from '../threads/thread-context';
import { cn } from '../../ui/cn';
import { ThreadPanel } from '../threads/thread';
import { FilesPanel } from './files-panel';
import { PinsPanel } from '../pins/pins-panel';
import { IncidentBanner } from '../incidents/incident-banner';
import { IncidentPanel } from '../incidents/incident-panel';
import { ProfilePanel } from '../profile/profile-panel';
import { PinIntentsProvider } from '../pins/use-pin';
import { SidePanelProvider, useSidePanel } from './side-panel';

const JoinBar = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t } = useI18n();
  const { joinChannel } = useActions();
  const describe = useDescribeFailure();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3 border-t-hairline border-border-subtle px-4 py-3">
      <p className="text-body text-ink-muted">
        {t('channel.join.notice', { name: channel.name ?? '' })}
      </p>
      <Button
        variant="primary"
        busy={busy}
        onClick={() => {
          setBusy(true);
          setFailed(null);
          joinChannel(channel.id).catch((failure: unknown) => {
            setBusy(false);
            setFailed(describe(failure));
          });
        }}
      >
        {t('channel.join.action')}
      </Button>
      {failed !== null && (
        <p role="alert" className="text-label text-danger-text">
          {`${t('channel.join.failed')} ${failed}`}
        </p>
      )}
    </div>
  );
};

/**
 * The channel's own column: header, feed and composer. Below the narrow line an open thread covers
 * it, and what is covered is hidden too — from a screen reader and from Tab — while keeping its
 * place and its scroll, so closing the thread puts the reader back where they were.
 */
const ConversationColumn = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const { openId } = useOpenThread();
  const { panel } = useSidePanel();
  const covered = openId !== null || panel !== null;
  return (
    <div className={cn('flex min-w-0 flex-1 flex-col', covered && 'max-narrow:invisible')}>
      {children}
    </div>
  );
};

const ChannelView = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const title = useChannelTitle(channel);
  const { workspace } = useWorkspace();
  const { t } = useI18n();
  const { search, navigate } = useRoute();
  const member = channel.state !== null;
  const conversation = channel.type === 'direct_message';
  // The thread the address asks for, read when the channel opens and not again.
  const [openThread] = useState(() => threadInSearch(search));
  // The message the address links to, until it turns out not to be one the person can read here.
  const linked = messageInSearch(search);
  const [missing, setMissing] = useState<string | null>(null);
  const around = linked !== null && linked !== missing ? linked : null;
  const leaveWindow = useCallback((): void => {
    navigate(href('channel', { slug: workspace.slug, channelId: channel.id }), { replace: true });
  }, [navigate, workspace.slug, channel.id]);
  useEffect(() => {
    rememberChannel(workspace.id, channel.id);
  }, [workspace.id, channel.id]);
  // Frozen when the channel is opened: the marker is the reader's place-holder, so it stays
  // while they read past it instead of vanishing the moment it is seen (`UX.md` §6).
  const [opened] = useState(() => ({
    after: channel.state?.lastReadMessageId ?? null,
    unread: (channel.state?.unreadCount ?? 0) > 0,
  }));
  // Once a link has moved the reader in this visit, the unread place is no longer where they are:
  // Jump to recent means the bottom, not back to the marker (D-149).
  const [followedLink, setFollowedLink] = useState(around !== null);
  useEffect(() => {
    if (around !== null) setFollowedLink(true);
  }, [around]);

  return (
    <EditingProvider>
      <ThreadsProvider openThread={openThread}>
        <SidePanelProvider>
          <PinIntentsProvider>
            <div className="relative flex min-h-0 flex-1">
              <ConversationColumn>
                <ChannelHeader channel={channel} />
                {!conversation && <IncidentBanner channel={channel} />}
                {linked !== null && linked === missing && (
                  <p
                    role="status"
                    className="flex shrink-0 items-center gap-2 border-b-hairline border-border-subtle px-4 py-1 text-caption text-ink-muted"
                  >
                    <Icon name="info" size="sm" />
                    {t('feed.linkMissing')}
                  </p>
                )}
                <MessageFeed
                  // Another message linked is another window, with its own place and its own mark.
                  key={around ?? ''}
                  channelId={channel.id}
                  channelName={title}
                  conversation={conversation}
                  markerAfter={member && opened.unread && !followedLink ? opened.after : undefined}
                  readAtOpen={opened.after}
                  member={member}
                  openThread={openThread}
                  around={around}
                  onLinkMissing={setMissing}
                  onLeaveWindow={leaveWindow}
                />
                {member ? (
                  <Composer channelId={channel.id} channelName={title} autoFocus />
                ) : (
                  <JoinBar channel={channel} />
                )}
              </ConversationColumn>
              <ThreadPanel
                channelId={channel.id}
                around={around}
                channelLabel={conversation ? title : `#${title}`}
                channelName={title}
              />
              <FilesPanel
                channelId={channel.id}
                channelLabel={conversation ? title : `#${title}`}
              />
              <PinsPanel channelId={channel.id} channelLabel={conversation ? title : `#${title}`} />
              {!conversation && <IncidentPanel channel={channel} channelLabel={`#${title}`} />}
              <ProfilePanel person={conversation ? channel.peer : null} />
            </div>
          </PinIntentsProvider>
        </SidePanelProvider>
      </ThreadsProvider>
    </EditingProvider>
  );
};

export const ChannelScreen = ({ channelId }: { readonly channelId: string }): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const channel = channels.data?.find((c) => c.id === channelId);
  const gone = useGone(channelId);
  if (channels.isPending) {
    return (
      <>
        <ScreenBar />
        <LoadingStatus label={t('common.loading')} className="p-4">
          <Skeleton className="w-sidebar" />
        </LoadingStatus>
      </>
    );
  }
  if (channel === undefined) {
    // Archived, or left on another screen, while it was open: said as what happened (D-123).
    const why = gone === 'archived' ? 'archived' : gone === 'left' ? 'left' : 'missing';
    return (
      <>
        <ScreenBar />
        <EmptyState
          as="h1"
          title={t(`state.channel.${why}.title`)}
          body={t(`state.channel.${why}.body`)}
        />
      </>
    );
  }
  return <ChannelView key={channel.id} channel={channel} />;
};
