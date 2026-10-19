/**
 * Pin, beside Save on a message (D-130) and again in its More menu (D-150), and the mark a pinned
 * message carries in the feed.
 *
 * Both read the channel's pins with what has been asked laid over them (`use-pin.ts`); outside a
 * channel visit there is nothing to pin in, and both draw nothing. Pin is a member's: for anyone
 * else the button is not there. Its name stays "Pin" whatever it is, and `aria-pressed` says whether
 * the message is — a name that changed with the state would read as a double negative.
 */
import type { Message } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { IconButton } from '../../ui/icon-button';
import { MenuItem } from '../../ui/menu';
import { useHasPinIntents, useIsPinned, usePin } from './use-pin';

const Toggle = ({ message }: { readonly message: Message }): React.JSX.Element | null => {
  const { t } = useI18n();
  const { pinned, canPin, pending, toggle } = usePin(message);
  if (!canPin) return null;
  return (
    <IconButton
      size="bar"
      glyph={pinned ? 'unpin' : 'pin'}
      label={t('pins.pin')}
      tooltip={t(pinned ? 'pins.unpin' : 'pins.pin')}
      aria-pressed={pinned}
      aria-busy={pending}
      onClick={toggle}
    />
  );
};

export const PinToggle = ({ message }: { readonly message: Message }): React.JSX.Element | null =>
  useHasPinIntents() ? <Toggle message={message} /> : null;

const Item = ({ message }: { readonly message: Message }): React.JSX.Element | null => {
  const { t } = useI18n();
  const { pinned, canPin, toggle } = usePin(message);
  if (!canPin) return null;
  return (
    <MenuItem glyph={pinned ? 'unpin' : 'pin'} onSelect={toggle}>
      {t(pinned ? 'pins.unpin' : 'pins.pin')}
    </MenuItem>
  );
};

/** Pin in a message's More menu, for whoever looks for it there rather than on the bar. */
export const PinMenuItem = ({
  message,
}: {
  readonly message: Message;
}): React.JSX.Element | null => (useHasPinIntents() ? <Item message={message} /> : null);

const Mark = ({ message }: { readonly message: Message }): React.JSX.Element | null => {
  const { t } = useI18n();
  if (!useIsPinned(message)) return null;
  return (
    <span className="inline-flex items-center gap-1 text-caption text-ink-subtle">
      <Icon name="pin" size="sm" />
      {t('pins.pinned')}
    </span>
  );
};

/** "Pinned", under a message that is. */
export const PinnedMark = ({ message }: { readonly message: Message }): React.JSX.Element | null =>
  useHasPinIntents() ? <Mark message={message} /> : null;
