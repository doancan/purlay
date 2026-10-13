/**
 * Whether a message is pinned in its channel, and pinning or letting it go (D-130).
 *
 * **One list for the channel** — its pins (`GET …/pins`), read once and kept current by
 * `PINS_UPDATED` — marks a message pinned wherever it is drawn, and is what the Pins panel lists.
 *
 * **Painted at once**: the pin appears, or goes, before the server answers; a refusal puts the list
 * back and says why, with Retry — never a silent drop (CONTRIBUTING §1.9). Only a member of the
 * channel can pin in it (D-130 §2), so for anyone else there is nothing to press.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { Message, PinList } from '@purlay/types';
import { useApi } from '../../data/api-provider';
import { readAgain } from '../../data/cache';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useChannelPins, useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useToast } from '../../ui/toast';
import { useFeedPorts } from '../channel/feed-ports';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';

export interface PinControl {
  readonly pinned: boolean;
  /** Whether the person may change it: a member of the channel. */
  readonly canPin: boolean;
  readonly toggle: () => void;
}

/** Whether the message is in its channel's pins, by the list the channel holds. */
export const useIsPinned = (message: Message): boolean => {
  const pins = useChannelPins(message.channelId);
  return (pins.data ?? []).some((pin) => pin.message.id === message.id);
};

export const usePin = (message: Message): PinControl => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const { user } = useSession();
  const { workspace } = useWorkspace();
  const clock = useFeedPorts().clock;
  const channels = useChannels(workspace.id);
  const pinned = useIsPinned(message);
  const canPin = channels.data?.find((channel) => channel.id === message.channelId)?.state != null;

  const change = (pinning: boolean): void => {
    const key = keys.pins(message.channelId);
    const before = client.getQueryData<PinList>(key);
    const without = (before ?? []).filter((pin) => pin.message.id !== message.id);
    client.setQueryData<PinList>(
      key,
      pinning
        ? [
            {
              message,
              pinnedBy: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                avatarUrl: user.avatarUrl,
              },
              pinnedAt: clock.now().toISOString(),
            },
            ...without,
          ]
        : without,
    );
    (pinning ? api.pin(message.id) : api.unpin(message.id)).then(
      () => {
        // The server's list is the one that counts: who pinned it, when, and anyone else's change.
        readAgain(client, key);
      },
      (failure: unknown) => {
        client.setQueryData<PinList>(key, before);
        show({
          message: `${t(pinning ? 'pins.failed' : 'pins.unpinFailed')} ${describe(failure)}`,
          actionLabel: t('common.retry'),
          onAction: () => {
            change(pinning);
          },
        });
      },
    );
  };

  return {
    pinned,
    canPin,
    toggle: (): void => {
      change(!pinned);
    },
  };
};
