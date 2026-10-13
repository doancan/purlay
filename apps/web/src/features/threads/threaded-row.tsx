/**
 * A message row with its thread's line: what the feed draws for a root (D-122).
 *
 * It hands the row the two slots it exposes for this — the line under the content that opens the
 * thread in the panel (`children`) and a Reply beside React (`actions`) — and two more facts:
 * whether the thread is resolved, so the root's text goes quiet (`dimmed`), and whether it is the
 * one open in the panel (`threadOpen`). The row itself knows nothing of threads, and a reply is
 * the same row with none of this.
 *
 * **It is memoised like the row it wraps.** It reads which thread is open, so every root's wrapper
 * renders when the panel changes; the rows under them do not, because only the two whose
 * `threadOpen` changed get different props (`message-row.tsx`).
 */
import { memo, useCallback, useMemo } from 'react';
import { IconButton } from '../../ui/icon-button';
import { useI18n } from '../../i18n/i18n-provider';
import { MessageRow, type MessageRowProps } from '../messages/message-row';
import { useThreadView, useThreads } from './thread-context';
import { ThreadSummary } from './thread-summary';

export type ThreadedMessageRowProps = Omit<MessageRowProps, 'actions' | 'children'>;

const ThreadedMessageRowView = (row: ThreadedMessageRowProps): React.JSX.Element => {
  const { t } = useI18n();
  const threads = useThreads();
  const { message, delivery = 'sent', nowMinute } = row;
  // Only a root the server has can be replied to or have a thread (I-1; a pending row has no id to hang one on yet).
  const threaded = message.parentId === null && delivery === 'sent';
  const resolved = message.thread?.resolvedAt != null;
  const viewed = useThreadView(message.id);
  const open = viewed && threaded;

  const reply = useCallback((): void => {
    threads.open(message.id, 'reply');
  }, [threads, message.id]);
  const label = t('thread.reply');
  const actions = useMemo(
    () =>
      threaded ? (
        <IconButton label={label} glyph="reply" shortcut="R" onClick={reply} />
      ) : undefined,
    [threaded, label, reply],
  );
  const summary = useMemo(
    () =>
      threaded ? <ThreadSummary root={message} nowMinute={nowMinute} open={open} /> : undefined,
    [threaded, message, nowMinute, open],
  );

  return (
    <MessageRow {...row} dimmed={threaded && resolved} threadOpen={open} actions={actions}>
      {summary}
    </MessageRow>
  );
};

export const ThreadedMessageRow = memo(ThreadedMessageRowView);
