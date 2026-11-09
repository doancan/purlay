import { useId } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Checkbox } from '../../../ui/checkbox';
import { Select } from '../../../ui/select';
import { useAlertPreferences } from '../../alerts/preferences-context';
import { usePushControls } from '../../push/push';
import { SettingsCard, SettingsRow } from '../page';

export const AlertDeliveryCard = (): React.JSX.Element => {
  const { t } = useI18n();
  const { preferences, change, remembered, audio, preview } = useAlertPreferences();
  const push = usePushControls();
  const id = useId();
  return (
    <SettingsCard title={t('alerts.delivery')} description={t('alerts.deliveryHint')}>
      <SettingsRow
        label={t('alerts.inApp')}
        description={t('alerts.inAppHint')}
        htmlFor={`${id}-inapp`}
      >
        <Checkbox
          id={`${id}-inapp`}
          checked={preferences.inApp}
          onChange={(event) => {
            change({ inApp: event.target.checked });
          }}
        />
      </SettingsRow>
      <SettingsRow
        label={t('alerts.sound')}
        description={t('alerts.soundHint')}
        htmlFor={`${id}-sound`}
      >
        <Checkbox
          id={`${id}-sound`}
          checked={preferences.sound}
          onChange={(event) => {
            change({ sound: event.target.checked });
          }}
        />
      </SettingsRow>
      <SettingsRow
        label={t('alerts.volume')}
        description={t('alerts.volumeHint')}
        htmlFor={`${id}-volume`}
        wide
      >
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Select
              id={`${id}-volume`}
              value={String(preferences.volume)}
              onChange={(event) => {
                change({ volume: Number(event.target.value) });
              }}
            >
              {[...new Set([0, 25, 50, 75, 100, preferences.volume])]
                .sort((a, b) => a - b)
                .map((volume) => (
                  <option key={volume} value={volume}>
                    {t('alerts.percent', { volume })}
                  </option>
                ))}
            </Select>
            <Button
              glyph="notifications"
              onClick={preview}
              disabled={audio === 'unavailable' || preferences.volume === 0}
            >
              {t('alerts.preview')}
            </Button>
          </div>
          <p role="status" className="text-label font-normal text-ink-muted">
            {t(`alerts.audio.${audio}`)}
          </p>
        </div>
      </SettingsRow>
      {!remembered && (
        <p
          role="status"
          className="mx-6 mb-5 text-label font-normal text-ink-muted max-narrow:mx-4"
        >
          {t('alerts.notRemembered')}
        </p>
      )}
      {push?.status === 'on' && push.closedTab && push.soundSync !== undefined && (
        <p
          role="status"
          className="mx-6 mb-5 text-label font-normal text-ink-muted max-narrow:mx-4"
        >
          {t(`alerts.sync.${push.soundSync}`)}
        </p>
      )}
      {push?.soundSync === 'failed' && (
        <div className="mx-6 mb-5 max-narrow:mx-4">
          <Button onClick={push.retrySound}>{t('common.retry')}</Button>
        </div>
      )}
    </SettingsCard>
  );
};
