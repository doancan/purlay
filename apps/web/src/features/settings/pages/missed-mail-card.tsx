/**
 * Email about what the person missed (D-240), on Notifications: one switch, off until they turn it on. Drawn
 * only where the server can send mail and their address was verified — where it cannot, nothing would come,
 * and a switch that does nothing is worse than none. Changed at once, as a channel's level is: painted, put
 * back and said when the server refuses. Not drawn while it is being asked; a failure to ask is said, with a
 * retry.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { MissedMailSetting } from '@purlay/types';
import { useApi } from '../../../data/api-provider';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Checkbox } from '../../../ui/checkbox';
import { useToast } from '../../../ui/toast';
import { SettingsCard, SettingsRow } from '../page';

export const MissedMailCard = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const id = useId();
  // What was just chosen, painted in the same frame as the click, until the server's answer replaces it.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const setting = useQuery({
    queryKey: keys.missedMail,
    queryFn: async ({ signal }) => await api.missedMail(signal),
  });
  if (setting.isError) {
    // Not known whether it can be offered: said, with the way to ask again, rather than silently not drawn.
    return (
      <SettingsCard title={t('missedMail.title')} description={t('missedMail.description')}>
        <div className="flex items-center gap-3 px-6 py-5 max-narrow:px-4">
          <p className="min-w-0 flex-1 text-body text-ink-muted">{describe(setting.error)}</p>
          <Button
            onClick={() => {
              void setting.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      </SettingsCard>
    );
  }
  // Nothing to offer, or not known yet: the card is not drawn rather than drawn and then taken away.
  const before: MissedMailSetting | undefined = setting.data;
  if (before?.available !== true) return null;

  const change = (next: boolean): void => {
    setChosen(next);
    api.setMissedMail({ on: next }).then(
      (kept) => {
        client.setQueryData(keys.missedMail, kept);
        setChosen(null);
      },
      (failure: unknown) => {
        setChosen(null);
        show({ message: `${t('missedMail.failed')} ${describe(failure)}` });
      },
    );
  };

  return (
    <SettingsCard title={t('missedMail.title')} description={t('missedMail.description')}>
      <SettingsRow label={t('missedMail.on')} description={t('missedMail.hint')} htmlFor={id}>
        <Checkbox
          id={id}
          checked={chosen ?? before.on}
          onChange={(event) => {
            change(event.target.checked);
          }}
        />
      </SettingsRow>
    </SettingsCard>
  );
};
