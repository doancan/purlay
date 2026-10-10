/**
 * The channel's header: its name, what it is for, and the two ways to look at it —
 * the feed and the workspace's open questions, with their live count (`UX.md` §2, §4.4).
 *
 * A channel's name is set in the mono face with a `#`, like the sidebar's (the approved
 * prototype's choice: this is where code gets pasted). A direct message has no name, so it
 * shows the other person; a note to oneself says so. The count beside "Open questions" is
 * the same number the sidebar shows and comes from the same cache entry
 * (`use-open-count.ts`), so the two cannot differ.
 */
import type { Channel } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Link } from '../../router/router-provider';
import { cn } from '../../ui/cn';
import { useOpenCount } from '../questions/use-open-count';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';

const tabClasses =
  'inline-flex h-control items-center gap-2 rounded-md px-3 text-label hover:bg-surface-200 hover:text-ink';

/** What a person calls this channel: its name, or who they are talking to. */
export const useChannelTitle = (channel: Channel): string => {
  const { t } = useI18n();
  const { user } = useSession();
  if (channel.type !== 'direct_message') return channel.name ?? '';
  const peer = channel.peer;
  if (peer === null) return channel.name ?? '';
  return peer.id === user.id ? t('feed.selfDm', { name: peer.username }) : peer.username;
};

export const ChannelHeader = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const title = useChannelTitle(channel);
  const open = useOpenCount(workspace.id);
  const direct = channel.type === 'direct_message';

  return (
    <header className="flex h-header shrink-0 items-center justify-between gap-4 border-b-hairline border-border-subtle px-4">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="flex items-center gap-1 text-title text-ink">
          <Icon name={direct ? 'person' : 'channel'} size="lg" />
          <span className="font-mono">{title}</span>
        </h1>
        <span className="truncate text-caption text-ink-muted">
          {direct ? '' : (channel.topic ?? t('header.noTopic'))}
        </span>
      </div>
      <nav aria-label={t('header.views')} className="flex gap-1">
        <Link
          to="channel"
          params={{ slug: workspace.slug, channelId: channel.id }}
          aria-current="page"
          className={cn(tabClasses, 'bg-surface-200 text-ink')}
        >
          {t('header.feed')}
        </Link>
        <Link
          to="questions"
          params={{ slug: workspace.slug }}
          className={cn(tabClasses, 'text-ink-muted')}
        >
          {t('header.questions')}
          {open !== null && open.count > 0 && (
            <span className="font-mono text-warning-text">
              {format.number(open.count)}
              {open.more && '+'}
            </span>
          )}
        </Link>
      </nav>
    </header>
  );
};
