import { useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@purlay/types';
import { useId, useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Checkbox } from '../../../ui/checkbox';
import { SaveOutcome, SettingsCard, SettingsRow } from '../page';

export const UrgentMessagesCard = ({
  workspaceId,
  enabled,
}: {
  readonly workspaceId: string;
  readonly enabled: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const id = useId();
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; words: string } | null>(null);

  const change = async (next: boolean): Promise<void> => {
    if (chosen !== null) return;
    const who = client.getQueryData<MeResponse>(keys.me)?.user.id;
    setChosen(next);
    setOutcome(null);
    try {
      const saved = await api.setUrgentMessages(workspaceId, next);
      client.setQueryData<MeResponse>(keys.me, (session) =>
        session === undefined || session.user.id !== who
          ? session
          : {
              ...session,
              memberships: session.memberships.map((member) =>
                member.workspace.id === workspaceId
                  ? { ...member, urgentMessagesEnabled: saved.enabled }
                  : member,
              ),
            },
      );
      void client.invalidateQueries({ queryKey: keys.me });
      setOutcome({ ok: true, words: t('profile.saved') });
    } catch (failure) {
      setOutcome({
        ok: false,
        words: `${t('settings.general.urgentMessages.failed')} ${describe(failure)}`,
      });
    } finally {
      setChosen(null);
    }
  };

  return (
    <SettingsCard
      title={t('settings.general.urgentMessages.title')}
      footer={<SaveOutcome outcome={outcome} />}
    >
      <SettingsRow
        label={t('settings.general.urgentMessages.allow')}
        description={t('settings.general.urgentMessages.hint')}
        htmlFor={id}
      >
        <Checkbox
          id={id}
          checked={chosen ?? enabled}
          disabled={chosen !== null}
          aria-busy={chosen !== null || undefined}
          onChange={(event) => {
            void change(event.target.checked);
          }}
        />
      </SettingsRow>
    </SettingsCard>
  );
};
