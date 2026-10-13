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
 * A channel the person can see but has not joined has no read position and cannot be
 * written to; it shows its messages and a way to join, in place of the composer, so a link
 * to a public channel is useful before they are in it.
 */
import { useDescribeFailure } from '../../data/failure';
import { useEffect, useState } from 'react';
import type { Channel } from '@purlay/types';
import { useActions } from '../../data/actions-provider';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { EmptyState } from '../../ui/states';
import { EditingProvider } from '../messages/editing';
import { Composer } from '../composer/composer';
import { threadInSearch } from '../../router/routes';
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
  const { search } = useRoute();
  const member = channel.state !== null;
  const conversation = channel.type === 'direct_message';
  // The thread the address asks for, read when the channel opens and not again.
  const [openThread] = useState(() => threadInSearch(search));
  useEffect(() => {
    rememberChannel(workspace.id, channel.id);
  }, [workspace.id, channel.id]);
  // Frozen when the channel is opened: the marker is the reader's place-holder, so it stays
  // while they read past it instead of vanishing the moment it is seen (`UX.md` §6).
  const [opened] = useState(() => ({
    after: channel.state?.lastReadMessageId ?? null,
    unread: (channel.state?.unreadCount ?? 0) > 0,
  }));

  return (
    <EditingProvider>
      <ThreadsProvider openThread={openThread}>
        <SidePanelProvider>
          <div className="relative flex min-h-0 flex-1">
            <ConversationColumn>
              <ChannelHeader channel={channel} />
              <MessageFeed
                channelId={channel.id}
                channelName={title}
                conversation={conversation}
                markerAfter={member && opened.unread ? opened.after : undefined}
                readAtOpen={opened.after}
                member={member}
                openThread={openThread}
              />
              {member ? (
                <Composer channelId={channel.id} channelName={title} autoFocus />
              ) : (
                <JoinBar channel={channel} />
              )}
            </ConversationColumn>
            <ThreadPanel
              channelId={channel.id}
              channelLabel={conversation ? title : `#${title}`}
              channelName={title}
            />
            <FilesPanel channelId={channel.id} channelLabel={conversation ? title : `#${title}`} />
            <PinsPanel channelId={channel.id} channelLabel={conversation ? title : `#${title}`} />
          </div>
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
