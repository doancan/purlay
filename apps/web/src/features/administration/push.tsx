import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServerOverview } from '@purlay/types';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { SettingsCard } from '../settings/page';
import { ChangeFailure, Inset } from '../settings/server-parts';
import { useAdministrationClient } from './context';
import { QueryState } from './parts';

const KEY = ['server', 'push'] as const;
export const ServerPushCard = (): React.JSX.Element => {
  const client = useAdministrationClient();
  const queries = useQueryClient();
  const { t } = useI18n();
  const query = useQuery({
    queryKey: KEY,
    queryFn: async ({ signal }) => await client.pushSettings(signal),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const change = async (enabled: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await queries.cancelQueries({ queryKey: KEY });
      const saved = await client.savePushSettings(enabled);
      queries.setQueryData(KEY, saved);
      queries.setQueryData<ServerOverview>(['server', 'overview'], (current) =>
        current === undefined ? current : { ...current, pushConfigured: saved.enabled },
      );
      await Promise.all([
        queries.invalidateQueries({ queryKey: KEY }),
        queries.invalidateQueries({ queryKey: ['server', 'overview'] }),
        queries.invalidateQueries({ queryKey: ['server', 'audit'] }),
        queries.invalidateQueries({ queryKey: keys.pushKey }),
      ]);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsCard title={t('admin.browserPush')} description={t('admin.browserPush.body')}>
      <Inset>
        <QueryState query={query}>
          {(data) => (
            <>
              <p role="status" className="text-body text-ink">
                {t(data.enabled ? 'admin.browserPush.on' : 'admin.browserPush.off')}
              </p>
              <p className="text-body text-ink-muted">
                {t(data.keysCreated ? 'admin.browserPush.preserved' : 'admin.browserPush.generate')}
              </p>
              <Button
                busy={busy}
                disabled={busy || query.isFetching || query.isError}
                onClick={() => {
                  void change(!data.enabled);
                }}
              >
                {t(data.enabled ? 'admin.browserPush.disable' : 'admin.browserPush.enable')}
              </Button>
            </>
          )}
        </QueryState>
        {failure !== null && <ChangeFailure failure={failure} />}
        <p className="text-caption text-ink-muted">{t('admin.browserPush.permission')}</p>
      </Inset>
    </SettingsCard>
  );
};
