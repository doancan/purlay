/**
 * The Reminders tab of Saved: what the person asked to be reminded of, the soonest first — when, and
 * the message with who and where, opening it in its conversation, with Change… and Remove. Read again
 * on opening, on focus and on `REMINDERS_UPDATED`, since a reminder is also set and cancelled on other
 * devices and delivered while the screen is open.
 */
import { useMemo, useState } from 'react';
import type { Channel, Message, MessageReminder } from '@purlay/types';
import { Icon } from '../../../components/icon';
import { useDeferred } from '../../../app/deferred-door';
import { useChannels } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { messageHref } from '../../../router/routes';
import { useRoute } from '../../../router/router-provider';
import { Avatar } from '../../../ui/avatar';
import { Button } from '../../../ui/button';
import { cn } from '../../../ui/cn';
import { ListCard, listButtonClasses, listRowClasses } from '../../../ui/list-column';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { ErrorState, GlyphEmptyState } from '../../../ui/states';
import { authorOf } from '../../../lib/author';
import { useMessageText } from '../../content/github-event';
import { useWorkspace } from '../../shell/workspace';
import { useChannelTitle } from '../channel/channel-header';
import { useReminderActions, useReminders } from '../reminders/use-reminders';

const ChannelName = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const title = useChannelTitle(channel);
  return <span>{channel.type === 'direct_message' ? title : `#${title}`}</span>;
};

const Row = ({
  reminder,
  channel,
  onOpen,
  onChange,
  onRemove,
}: {
  readonly reminder: MessageReminder;
  readonly channel: Channel | undefined;
  readonly onOpen: () => void;
  readonly onChange: () => void;
  readonly onRemove: () => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const textOf = useMessageText();
  const { message } = reminder;
  const author = authorOf(message, t('user.erased'));
  return (
    <li className={cn('group relative', listRowClasses)}>
      <button type="button" className={listButtonClasses('pr-5')} onClick={onOpen}>
        <Avatar name={author.displayName} username={author.username} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2 whitespace-nowrap text-label text-ink-muted">
            <span className="min-w-0 truncate font-semibold text-ink">{author.displayName}</span>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">
              {channel === undefined ? t('questions.unnamed') : <ChannelName channel={channel} />}
            </span>
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 font-mono text-caption">
              <Icon name="reminder" size="sm" />
              <time dateTime={reminder.remindAt}>{format.absolute(reminder.remindAt)}</time>
            </span>
          </span>
          <span className="line-clamp-2 block text-body text-ink">{textOf(message)}</span>
        </span>
      </button>
      {/* Beside the row's button, as Saved's are: on a pointer with the row's hover or a keyboard's
          focus, on a phone always, under the words. */}
      <div className="absolute top-1 right-3 flex gap-1 bg-surface-050 pl-2 opacity-0 transition-opacity duration-hover ease-standard group-hover:opacity-100 focus-within:opacity-100 max-narrow:static max-narrow:flex-wrap max-narrow:bg-transparent max-narrow:px-3 max-narrow:pt-0 max-narrow:pb-3 max-narrow:opacity-100">
        <span
          aria-hidden="true"
          className="hidden shrink-0 max-narrow:block max-narrow:size-avatar"
        />
        <Button variant="ghost" onClick={onChange}>
          {t('reminders.change')}
        </Button>
        <Button
          variant="dangerQuiet"
          glyph="delete"
          aria-label={t('reminders.remove')}
          onClick={onRemove}
        >
          {t('reminders.removeShort')}
        </Button>
      </div>
    </li>
  );
};

export const RemindersTab = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const query = useReminders(workspace.id, { fresh: true });
  const actions = useReminderActions();
  const channels = useChannels(workspace.id);
  const byId = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c])), [channels.data]);
  const [changing, setChanging] = useState<Message | null>(null);
  const [open, setOpen] = useState(false);
  const deferred = useDeferred([open, setOpen]);
  const items = query.data ?? [];

  if (query.isPending)
    return (
      <LoadingStatus label={t('reminders.loading')} className="flex flex-col gap-4 py-2">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex flex-col gap-2">
            <Skeleton className="w-members" />
            <Skeleton className="w-feed" />
          </div>
        ))}
      </LoadingStatus>
    );
  if (query.isError && query.data === undefined)
    return (
      <ErrorState
        title={t('reminders.error.title')}
        body={t('reminders.error.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  if (items.length === 0)
    return (
      <GlyphEmptyState
        glyph="reminder"
        tone="accent"
        title={t('reminders.empty.title')}
        body={t('reminders.empty.body')}
      />
    );
  return (
    <>
      <ListCard label={t('reminders.list')}>
        {items.map((reminder) => (
          <Row
            key={reminder.message.id}
            reminder={reminder}
            channel={byId.get(reminder.message.channelId)}
            onOpen={() => {
              navigate(
                messageHref(workspace.slug, reminder.message.channelId, reminder.message.id),
              );
            }}
            onChange={() => {
              setChanging(reminder.message);
              setOpen(true);
            }}
            onRemove={() => {
              actions?.cancel(reminder.message);
            }}
          />
        ))}
      </ListCard>
      {deferred !== null && changing !== null && (
        <deferred.ReminderDialog message={changing} open={open} onOpenChange={setOpen} />
      )}
    </>
  );
};
