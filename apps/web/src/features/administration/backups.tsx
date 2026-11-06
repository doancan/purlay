import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { SettingsCard } from '../settings/page';
import { Inset } from '../settings/server-parts';
import { useAdministrationClient } from './context';
import { Facts, QueryState } from './parts';

export const Backups = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const client = useAdministrationClient();
  const query = useQuery({
    queryKey: ['server', 'backups'],
    queryFn: async ({ signal }) => await client.backups(signal),
    retry: false,
  });
  return (
    <QueryState query={query}>
      {(data) => (
        <SettingsCard
          title={t('admin.backups')}
          description={t('admin.backups.body')}
          actions={
            <Button
              busy={query.isFetching}
              onClick={() => {
                void query.refetch();
              }}
            >
              {t('admin.refresh')}
            </Button>
          }
        >
          <Inset>
            <p role="status" className="text-body text-ink">
              {t(`admin.backup.${data.state}`)}
            </p>
          </Inset>
          {data.backup !== null && (
            <Facts
              items={[
                [t('admin.lastBackup'), format.absolute(data.backup.completedAt)],
                [t('admin.backup.scope'), t(`admin.backup.${data.backup.scope}`)],
                [t('admin.backup.size'), format.bytes(Number(data.backup.databaseBytes))],
                [t('admin.backup.source'), data.backup.source],
                [
                  t('admin.backup.hash'),
                  <span className="font-mono text-caption break-all">
                    {data.backup.databaseSha256}
                  </span>,
                ],
              ]}
            />
          )}
          <Inset>
            {data.restore === null ? (
              <p className="text-body text-ink-muted">{t('admin.backup.restoreNone')}</p>
            ) : (
              <>
                <p className="text-body text-ink">
                  {t(
                    data.restoreMatchesLatest
                      ? 'admin.backup.restoreMatches'
                      : 'admin.backup.restoreOther',
                  )}
                </p>
                <p className="text-caption text-ink-muted">
                  {format.absolute(data.restore.checkedAt)} ·{' '}
                  {t(`admin.backup.${data.restore.scope}`)}
                </p>
              </>
            )}
            <p className="text-caption text-ink-muted">{t('admin.backup.restoreLimit')}</p>
            <a
              className="text-label text-accent-text underline"
              href="https://github.com/doancan/purlay/blob/main/docs/DEPLOY.md"
            >
              {t('admin.backup.guide')}
            </a>
          </Inset>
        </SettingsCard>
      )}
    </QueryState>
  );
};
