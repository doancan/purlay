/**
 * What the person is told about in this channel (D-107), from its header: every message, what is
 * addressed to them (the default), or nothing. Only a member has a level; somebody who can see a
 * channel without being in it is told nothing here and is offered nothing.
 *
 * Painted before the server answers (CONTRIBUTING §1.9): the bell is the chosen level at once, and a
 * refusal puts the one it had back and says why.
 */
import type { Channel, NotificationLevel } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../data/api-provider';
import { channelLevelChanged } from '../../data/cache';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { IconButton } from '../../ui/icon-button';
import { Menu, MenuLabel, MenuRadioGroup, MenuRadioItem } from '../../ui/menu';
import { useToast } from '../../ui/toast';

export const LEVELS: readonly NotificationLevel[] = ['all', 'mentions', 'none'];

const levelOf = (value: string): NotificationLevel | undefined =>
  LEVELS.find((level) => level === value);

/**
 * Choosing a level, for the header's menu and the channel's details alike: painted at once, put back
 * and said in a toast when the server refuses.
 */
export const useChooseLevel = (channel: Channel): ((level: NotificationLevel) => void) => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const current = channel.notificationLevel;
  return (level) => {
    if (current === null || level === current) return;
    channelLevelChanged(client, channel.id, level);
    api.setNotificationLevel(channel.id, level).catch((failure: unknown) => {
      channelLevelChanged(client, channel.id, current);
      show({ message: `${t('level.failed')} ${describe(failure)}` });
    });
  };
};

export const NotificationLevelMenu = ({
  channel,
}: {
  readonly channel: Channel;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const choose = useChooseLevel(channel);
  const current = channel.notificationLevel;
  if (current === null) return null;

  return (
    <Menu
      align="end"
      trigger={
        <IconButton
          label={t('level.button', { level: t(`level.${current}.short`) })}
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
    </Menu>
  );
};
