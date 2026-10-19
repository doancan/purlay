/**
 * When a thread counts as read (D-147, `UX.md` §6).
 *
 * The channel's read position reads the feed and nothing in a thread: an answer somebody gave in a
 * thread keeps waiting — on the channel's badge, in the tab title and in the inbox — until the
 * thread is open in front of the person. Then its replies are read **up to the newest one the panel
 * has from the server**, never further, so a reply that arrives after the request is still waiting.
 *
 * Only while something in the channel needs the person (`waiting`, the channel's
 * `unreadMentionCount`): with nothing waiting there is nothing a thread could read, and opening one is
 * not a request. A request the server did not take is not retried in a loop; the next reply, or the
 * next time the thread is opened, asks again. The badge moves by the `CHANNEL_STATE` the server tells
 * the person's devices; the inbox, if it is cached, is asked for again.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../data/api-provider';
import { keys } from '../../data/keys';
import type { FeedPorts } from '../channel/feed-ports';

interface Options {
  readonly workspaceId: string;
  readonly rootId: string;
  /** The newest reply the server has confirmed in the panel; null while there is none. */
  readonly newestReplyId: string | null;
  /** Something in the channel needs the person. */
  readonly waiting: boolean;
  readonly ports: FeedPorts;
}

export const useReadThread = ({
  workspaceId,
  rootId,
  newestReplyId,
  waiting,
  ports,
}: Options): void => {
  const api = useApi();
  const client = useQueryClient();
  const sent = useRef<string | null>(null);
  const [visible, setVisible] = useState(() => ports.pageVisible());

  useEffect(
    () =>
      ports.onPageVisibility(() => {
        setVisible(ports.pageVisible());
      }),
    [ports],
  );

  useEffect(() => {
    if (!waiting || !visible || newestReplyId === null) return;
    if (sent.current !== null && newestReplyId <= sent.current) return;
    const previous = sent.current;
    sent.current = newestReplyId;
    api.readThread(rootId, newestReplyId).then(
      () => {
        void client.invalidateQueries({ queryKey: keys.notifications(workspaceId) });
      },
      () => {
        // Unless something newer went out since, nothing past the earlier bound was read.
        if (sent.current === newestReplyId) sent.current = previous;
      },
    );
  }, [api, client, workspaceId, rootId, newestReplyId, waiting, visible]);
};
