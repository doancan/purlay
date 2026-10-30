/** Which channels All unreads lists (D-216): joined, unread, not muted, in the sidebar's order. */
import type { Channel } from '@purlay/types';
import { inSidebarOrder } from '../palette/channels';

/** The channels with something new that asks to be read: joined, unread, not muted. */
export const waitingChannels = (channels: readonly Channel[]): readonly Channel[] =>
  inSidebarOrder(channels).filter(
    (channel) =>
      channel.state !== null &&
      channel.state.unreadCount > 0 &&
      channel.notificationLevel !== 'none',
  );
