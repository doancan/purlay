/**
 * What a notification says and where it leads (D-106): one reading, for the inbox's rows and for the
 * notice an open tab in the background shows (D-148), so the two cannot say a thing two ways.
 */
import type { Channel, Notification } from '@purlay/types';
import type { Translate } from '../../i18n/types';
import { href, threadHref } from '../../router/routes';
import { authorOf } from '../messages/author';

/** Why the person was told, in words: who did it, except for a resolution of their own question. */
export const whyOf = (
  t: Translate,
  notification: Notification,
  channel: Channel | undefined,
): string => {
  const name = authorOf(notification.message, t('user.erased')).displayName;
  switch (notification.type) {
    case 'mention':
      return t('inbox.why.mention', { name });
    case 'direct_message':
      // In a group it was written to several people, not to you alone (D-127).
      return channel !== undefined && channel.peers.length >= 2
        ? t('inbox.why.group', { name })
        : t('inbox.why.direct', { name });
    case 'thread_reply':
      return t('inbox.why.reply', { name });
    case 'thread_resolved':
      return t('inbox.why.resolved');
    case 'channel_message':
      return t('inbox.why.channel', { name });
  }
};

/** Where a notification takes the person: the thread a reply or a resolution belongs to, or the channel. */
export const targetOf = (slug: string, notification: Notification): string => {
  const { message } = notification;
  if (message.parentId !== null) return threadHref(slug, message.channelId, message.parentId);
  if (notification.type === 'thread_resolved' || notification.type === 'thread_reply') {
    return threadHref(slug, message.channelId, message.id);
  }
  return href('channel', { slug, channelId: message.channelId });
};
