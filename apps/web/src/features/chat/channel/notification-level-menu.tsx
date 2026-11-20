/**
 * What the person is told about in this channel (D-107), from its header: every message, what is
 * addressed to them (the default), or nothing — for good, or muted for a while (D-329). Only a member
 * has a level; somebody who can see a channel without being in it is told nothing here and is offered
 * nothing.
 *
 * Painted before the server answers (CONTRIBUTING §1.9): the bell is the chosen level at once, and a
 * refusal puts the one it had back and says why. A mute for a while says until when, and ends by
 * itself: the server holds the end, and the list is read again at that instant (`sidebar/level-ends.tsx`).
 */
import type { Channel, NotificationLevel } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../data/api-provider';
import { channelLevelChanged } from '../../../data/cache';
import { useDescribeFailure } from '../../../data/failure';
import type { Formatters } from '../../../i18n/format';
import { useI18n } from '../../../i18n/i18n-provider';
import { IconButton } from '../../../ui/icon-button';
import {
  Menu,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
} from '../../../ui/menu';
import { useToast } from '../../../ui/toast';
import { useFeedPorts } from './feed-ports';
import { MUTE_CHOICES, muteEnd } from './mute-presets';

export const LEVELS: readonly NotificationLevel[] = ['all', 'mentions', 'none'];

const levelOf = (value: string): NotificationLevel | undefined =>
  LEVELS.find((level) => level === value);

/** Until when a level chosen for a while lasts, or null for good — an older server sends nothing. */
const untilOf = (channel: Channel): string | null => channel.notificationLevelUntil ?? null;

/** The end as the viewer reads it: its clock time today, the whole date and time on another day. */
const endText = (until: string, now: Date, format: Formatters): string =>
  format.isoDay(until) === format.isoDay(now)
    ? format.inputValue(until).slice(-5)
    : format.absolute(until);

/**
 * Choosing a level, for the header's menu and the channel's details alike: for good, or until an
 * instant (D-329). Painted at once, put back and said in a toast when the server refuses.
 */
export const useChooseLevel = (
  channel: Channel | undefined,
): ((level: NotificationLevel, until?: string) => void) => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const current = channel?.notificationLevel ?? null;
  const currentUntil = channel === undefined ? null : untilOf(channel);
  return (level, until) => {
    if (channel === undefined || current === null) return;
    // The level already in force for good is nothing to send; the same level chosen for good ends a mute for a while.
    if (level === current && until === undefined && currentUntil === null) return;
    channelLevelChanged(client, channel.id, level, until ?? null);
    api.setNotificationLevel(channel.id, level, until).catch((failure: unknown) => {
      channelLevelChanged(client, channel.id, current, currentUntil);
      show({ message: `${t('level.failed')} ${describe(failure)}` });
    });
  };
};

export const NotificationLevelMenu = ({
  channel,
}: {
  readonly channel: Channel;
}): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const { clock } = useFeedPorts();
  const choose = useChooseLevel(channel);
  const current = channel.notificationLevel;
  if (current === null) return null;
  const now = clock.now();
  const until = untilOf(channel);
  const ends = until === null ? null : endText(until, now, format);

  return (
    <Menu
      align="end"
      trigger={
        <IconButton
          label={
            ends === null
              ? t('level.button', { level: t(`level.${current}.short`) })
              : t('level.buttonUntil', { level: t(`level.${current}.short`), time: ends })
          }
          // Each level its own bell, so what a channel tells is seen without opening the menu (UX §2).
          glyph={
            current === 'none' ? 'deep-work' : current === 'all' ? 'notify-all' : 'notifications'
          }
        />
      }
    >
      <MenuLabel>{t('level.label')}</MenuLabel>
      <MenuRadioGroup
        value={current}
        onValueChange={(value) => {
          const level = levelOf(value);
          if (level !== undefined) choose(level);
        }}
      >
        {LEVELS.map((level) => (
          <MenuRadioItem key={level} value={level}>
            {t(`level.${level}`)}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      {ends === null ? null : (
        <MenuLabel>
          {current === 'none'
            ? t('level.mutedUntil', { time: ends })
            : t('level.until', { level: t(`level.${current}`), time: ends })}
        </MenuLabel>
      )}
      <MenuSub glyph="deep-work" label={t('level.muteFor')}>
        {MUTE_CHOICES.map((choice) => {
          const end = muteEnd(choice, now, format);
          return (
            <MenuItem
              key={choice}
              onSelect={() => {
                // Worked out again as it is chosen: the menu may have stayed open a while.
                choose('none', muteEnd(choice, clock.now(), format));
              }}
            >
              {choice === 'tomorrow'
                ? t('level.mute.tomorrow')
                : t(`level.mute.${choice}`, { time: format.inputValue(end).slice(-5) })}
            </MenuItem>
          );
        })}
      </MenuSub>
    </Menu>
  );
};
