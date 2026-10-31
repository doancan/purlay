/**
 * Notifications (D-146): what can interrupt you, and the three things you set about it — Deep Work,
 * this device, and each channel's level.
 *
 * - **What interrupts you** is said first, in words (D-12, D-29): a mention, a direct message, a reply
 *   in a thread you are part of, and every message in a channel set to that level (D-107).
 * - **Deep Work** is started for a while, as from the account menu, and the server stops delivering
 *   (D-15, D-108); on, it says until when and offers its end.
 * - **This device** is the Web Push switch (D-126) where the browser and the server can send; where
 *   they cannot, the page says plainly that a closed tab hears nothing — PRD §4.5 owes that sentence
 *   and a missing switch alone does not say it.
 * - **Channels** lists every channel you are in with its level (D-107), changed here as from the
 *   channel's bell: painted at once, put back and said when refused.
 */
import type { Channel, NotificationLevel } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { Icon, type GlyphName } from '../../../components/icon';
import { useApi } from '../../../data/api-provider';
import { channelLevelChanged } from '../../../data/cache';
import { useDescribeFailure } from '../../../data/failure';
import { useChannels } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Select } from '../../../ui/select';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useToast } from '../../../ui/toast';
import { mustInstallForPush } from '../../push/device';
import { usePushControls } from '../../push/push';
import { DEEP_WORK_CHOICES, useDeepWorkControls } from '../../shell/deep-work';
import { useWorkspace } from '../../shell/workspace';
import { SettingsCard, SettingsPage, SettingsRow } from '../page';

const LEVELS: readonly NotificationLevel[] = ['all', 'mentions', 'none'];
const INTERRUPTS = [
  { kind: 'mention', glyph: 'mention' },
  { kind: 'direct', glyph: 'person' },
  { kind: 'reply', glyph: 'reply' },
  { kind: 'channel', glyph: 'channel' },
] as const satisfies readonly { readonly kind: string; readonly glyph: GlyphName }[];

const WhatInterrupts = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <SettingsCard
      title={t('settings.notifications.what')}
      description={t('settings.notifications.whatHint')}
    >
      <ul className="flex flex-col">
        {INTERRUPTS.map(({ kind, glyph }) => (
          <li
            key={kind}
            className="flex items-center gap-3 not-first:border-t-hairline border-border-subtle px-6 py-3 text-body text-ink max-narrow:px-4"
          >
            <span className="inline-flex size-avatar shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent-text">
              <Icon name={glyph} />
            </span>
            {t(`settings.notifications.what.${kind}`)}
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
};

const DeepWorkCard = (): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const deepWork = useDeepWorkControls();
  if (deepWork === null) return null;
  const { until } = deepWork;
  return (
    <SettingsCard
      title={t('deepWork.label')}
      description={t('settings.notifications.deepWorkHint')}
    >
      {until === null ? (
        <SettingsRow label={t('settings.notifications.deepWorkStart')} wide>
          {/* On a phone the four are two even columns, not a ragged wrap. */}
          <div className="flex flex-wrap gap-2 max-narrow:grid max-narrow:w-full max-narrow:grid-cols-2">
            {DEEP_WORK_CHOICES.map((choice) => (
              <Button
                key={choice}
                glyph="deep-work"
                onClick={() => {
                  deepWork.start(choice);
                }}
              >
                {t(`deepWork.choice.${choice}`)}
              </Button>
            ))}
          </div>
        </SettingsRow>
      ) : (
        <SettingsRow
          label={t('settings.notifications.deepWorkOn')}
          description={t('deepWork.left', {
            until: format.absolute(until),
            count: deepWork.minutesLeft(),
          })}
        >
          <Button glyph="notifications" onClick={deepWork.end}>
            {t('deepWork.stop')}
          </Button>
        </SettingsRow>
      )}
    </SettingsCard>
  );
};

const DeviceCard = (): React.JSX.Element => {
  const { t } = useI18n();
  const push = usePushControls();
  if (push === null) {
    // A browser that can show nothing: said plainly, as PRD §4.5 owes — and on an iPhone, what changes it.
    return (
      <SettingsCard title={t('push.label')} description={t('settings.notifications.deviceHint')}>
        <SettingsRow
          label={t('settings.notifications.away')}
          description={t(
            mustInstallForPush()
              ? 'settings.notifications.installFirst'
              : 'settings.notifications.unsupported',
          )}
        >
          <span className="inline-flex items-center gap-2 text-label text-ink-muted">
            <Icon name="info" size="sm" />
            {t('settings.notifications.unavailable')}
          </span>
        </SettingsRow>
      </SettingsCard>
    );
  }
  const { status, closedTab } = push;
  return (
    <SettingsCard title={t('push.label')} description={t('settings.notifications.deviceHint')}>
      <SettingsRow
        label={t('settings.notifications.away')}
        description={
          status === 'blocked'
            ? t('push.blocked')
            : status === 'on'
              ? t(closedTab ? 'settings.notifications.onBoth' : 'settings.notifications.onOpenTab')
              : t(
                  closedTab
                    ? 'settings.notifications.askBoth'
                    : 'settings.notifications.askOpenTab',
                )
        }
      >
        {status === 'on' ? (
          <div className="flex flex-wrap gap-2">
            {push.test !== null && <Button onClick={push.test}>{t('push.test')}</Button>}
            <Button onClick={push.turnOff}>{t('push.turnOff')}</Button>
          </div>
        ) : status === 'off' ? (
          <Button variant="primary" glyph="notifications" onClick={push.turnOn}>
            {t('push.turnOn')}
          </Button>
        ) : (
          <Button disabled busy={status !== 'blocked'}>
            {t(status === 'blocked' ? 'settings.notifications.blocked' : 'push.working')}
          </Button>
        )}
      </SettingsRow>
      {!closedTab && (
        <p className="mx-6 mb-5 rounded-lg bg-surface-200 px-4 py-3 text-label font-normal text-ink-muted max-narrow:mx-4">
          {t('settings.notifications.closedTabOff')}
        </p>
      )}
    </SettingsCard>
  );
};

const ChannelLevels = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);

  const choose = (channel: Channel, current: NotificationLevel, level: NotificationLevel): void => {
    if (level === current) return;
    channelLevelChanged(client, channel.id, level);
    api.setNotificationLevel(channel.id, level).catch((failure: unknown) => {
      channelLevelChanged(client, channel.id, current);
      show({ message: `${t('level.failed')} ${describe(failure)}` });
    });
  };

  const joined = (channels.data ?? [])
    .filter((channel) => channel.type !== 'direct_message' && channel.notificationLevel !== null)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  return (
    <SettingsCard
      title={t('settings.notifications.channels')}
      description={t('settings.notifications.channelsHint')}
    >
      {channels.isError ? (
        <div className="flex items-center gap-3 px-6 py-5 max-narrow:px-4">
          <p className="min-w-0 flex-1 text-body text-ink-muted">{describe(channels.error)}</p>
          <Button
            onClick={() => {
              void channels.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : channels.data === undefined ? (
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-3 px-6 py-5">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      ) : joined.length === 0 ? (
        <p className="px-6 py-5 text-body text-ink-muted max-narrow:px-4">
          {t('settings.notifications.noChannels')}
        </p>
      ) : (
        joined.map((channel) => {
          const current = channel.notificationLevel ?? 'mentions';
          const name = channel.name ?? '';
          return (
            <SettingsRow key={channel.id} label={`# ${name}`} fill>
              <Select
                aria-label={t('settings.notifications.levelOf', { channel: name })}
                value={current}
                className="w-full"
                onChange={(event) => {
                  const level = LEVELS.find((option) => option === event.target.value);
                  if (level !== undefined) choose(channel, current, level);
                }}
              >
                {LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {t(`level.${level}`)}
                  </option>
                ))}
              </Select>
            </SettingsRow>
          );
        })
      )}
    </SettingsCard>
  );
};

export const NotificationsPage = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <SettingsPage
      title={t('settings.notifications.title')}
      description={t('settings.notifications.description')}
    >
      <WhatInterrupts />
      <DeepWorkCard />
      <DeviceCard />
      <ChannelLevels />
    </SettingsPage>
  );
};
