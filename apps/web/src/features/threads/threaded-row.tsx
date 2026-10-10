/**
 * A message row with its thread: what the feed draws for a root.
 *
 * It hands the row the two slots it exposes for this — the thread under the content
 * (`children`) and a Reply beside React (`actions`) — and one more fact: whether the
 * thread is resolved, so the root's text goes quiet (`dimmed`). The row itself knows nothing
 * of threads, and a reply is the same row with none of this.
 *
 * **It is memoised like the row it wraps.** The thread element is made once per message and
 * only again when what it shows changes, and the only context the wrapper reads is
 * `useThreads`, which is stable: opening one thread does not re-render the other forty-nine
 * rows (`message-row.tsx`).
 */
import { memo, useCallback, useMemo } from 'react';
import { IconButton } from '../../ui/icon-button';
import { useI18n } from '../../i18n/i18n-provider';
import { MessageRow, type MessageRowProps } from '../messages/message-row';
import { useThreads } from './thread-context';
import { Thread } from './thread';

export interface ThreadedMessageRowProps extends Omit<MessageRowProps, 'actions' | 'children'> {
  /** The channel's name, for the reply box's label. */
  readonly channelName: string;
}

const ThreadedMessageRowView = ({
  channelName,
  ...row
}: ThreadedMessageRowProps): React.JSX.Element => {
  const { t } = useI18n();
  const threads = useThreads();
  const { message, delivery = 'sent', meId, nowMinute, members } = row;
  // Only a root the server has can be replied to or have a thread (I-1; a pending row has no id to hang one on yet).
  const threaded = message.parentId === null && delivery === 'sent';
  const resolved = message.thread?.resolvedAt != null;

  const reply = useCallback((): void => {
    threads.expand(message.id, { focusReply: true });
  }, [threads, message.id]);
  const label = t('thread.reply');
  const actions = useMemo(
    () =>
      threaded ? (
        <IconButton label={label} glyph="reply" shortcut="R" onClick={reply} />
      ) : undefined,
    [threaded, label, reply],
  );
  const thread = useMemo(
    () =>
      threaded ? (
        <Thread
          root={message}
          channelName={channelName}
          meId={meId}
          nowMinute={nowMinute}
          members={members}
        />
      ) : undefined,
    [threaded, message, channelName, meId, nowMinute, members],
  );

  return (
    <MessageRow {...row} dimmed={threaded && resolved} actions={actions}>
      {thread}
    </MessageRow>
  );
};

export const ThreadedMessageRow = memo(ThreadedMessageRowView);
