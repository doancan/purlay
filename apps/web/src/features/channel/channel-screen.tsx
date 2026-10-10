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
 * A channel the person can see but has not joined has no read position and cannot be
 * written to; it shows its messages and a way to join, in place of the composer, so a link
 * to a public channel is useful before they are in it.
 */
import { useState } from 'react';
import type { Channel } from '@purlay/types';
import { useActions } from '../../data/actions-provider';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { EmptyState } from '../../ui/states';
import { Composer } from '../composer/composer';
import { useWorkspace } from '../shell/workspace';
import { ChannelHeader, useChannelTitle } from './channel-header';
import { MessageFeed } from './message-feed';

const JoinBar = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t } = useI18n();
  const { joinChannel } = useActions();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
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
          setFailed(false);
          joinChannel(channel.id).catch(() => {
            setBusy(false);
            setFailed(true);
          });
        }}
      >
        {t('channel.join.action')}
      </Button>
      {failed && (
        <p role="alert" className="text-label text-danger-text">
          {t('channel.join.failed')}
        </p>
      )}
    </div>
  );
};

const ChannelView = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const title = useChannelTitle(channel);
  const member = channel.state !== null;
  // Frozen when the channel is opened: the marker is the reader's place-holder, so it stays
  // while they read past it instead of vanishing the moment it is seen (`UX.md` §6).
  const [opened] = useState(() => ({
    after: channel.state?.lastReadMessageId ?? null,
    unread: (channel.state?.unreadCount ?? 0) > 0,
  }));

  return (
    <>
      <ChannelHeader channel={channel} />
      <MessageFeed
        channelId={channel.id}
        channelName={title}
        markerAfter={member && opened.unread ? opened.after : undefined}
        readAtOpen={opened.after}
        member={member}
      />
      {member ? (
        <Composer channelId={channel.id} channelName={title} autoFocus />
      ) : (
        <JoinBar channel={channel} />
      )}
    </>
  );
};

export const ChannelScreen = ({ channelId }: { readonly channelId: string }): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const channel = channels.data?.find((c) => c.id === channelId);
  if (channels.isPending) {
    return (
      <LoadingStatus label={t('common.loading')} className="p-4">
        <Skeleton className="w-sidebar" />
      </LoadingStatus>
    );
  }
  if (channel === undefined) {
    return (
      <EmptyState
        as="h1"
        title={t('state.channel.missing.title')}
        body={t('state.channel.missing.body')}
      />
    );
  }
  return <ChannelView key={channel.id} channel={channel} />;
};
