import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { SettingsCard } from '../settings/page';
import { ChangeFailure, Inset } from '../settings/server-parts';
import { useAdministrationClient } from './context';
import { QueryState } from './parts';

export const SavedMailTest = ({
  enabled,
  email,
}: {
  readonly enabled: boolean;
  readonly email: string;
}): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t, format } = useI18n();
  const queries = useQueryClient();
  const query = useQuery({
    queryKey: ['server', 'mail-test'],
    queryFn: async ({ signal }) => await client.mailStatus(signal),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const test = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const report = await client.testMail();
      queries.setQueryData(['server', 'mail-test'], { lastTest: report });
      await queries.invalidateQueries({ queryKey: ['server', 'audit'] });
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsCard title={t('admin.mailTest')} description={t('admin.mailTest.body', { email })}>
      <Inset>
        <Button
          disabled={!enabled || busy}
          busy={busy}
          onClick={() => {
            void test();
          }}
        >
          {t('admin.mailTest.send')}
        </Button>
        {failure !== null && <ChangeFailure failure={failure} />}
        <QueryState query={query}>
          {(data) =>
            data.lastTest === null ? (
              <p className="text-body text-ink-muted">{t('admin.mailTest.none')}</p>
            ) : (
              <div role="status" className="flex flex-col gap-1 text-body text-ink">
                <p>
                  {t(data.lastTest.accepted ? 'admin.mailTest.accepted' : 'admin.mailTest.failed')}
                </p>
                <p className="text-caption text-ink-muted break-all">
                  {data.lastTest.host} · {format.absolute(data.lastTest.testedAt)}
                  {data.lastTest.reason === null ? '' : ` · ${data.lastTest.reason}`}
                </p>
              </div>
            )
          }
        </QueryState>
      </Inset>
    </SettingsCard>
  );
};
