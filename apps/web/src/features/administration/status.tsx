import type { ServerOverview } from '@purlay/types';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { SettingsCard } from '../settings/page';
import { useAdministrationClient } from './context';
import { Facts, QueryState } from './parts';
import { ServerProblems } from './problems';

export const Overview = (): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t, format } = useI18n();
  const query = useQuery({
    queryKey: ['server', 'overview'],
    queryFn: async ({ signal }) => await client.overview(signal),
    retry: false,
  });
  return (
    <>
      <ServerProblems overview={query} />
      <QueryState query={query}>
        {(data) => (
          <>
            <SettingsCard
              title={t('admin.overview')}
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
              <p role="status" className="px-6 py-4 text-body text-ink">
                {t(data.ready ? 'admin.ready' : 'admin.notReady')}
              </p>
              <p className="px-6 pb-4 text-caption text-ink-muted">
                {t('admin.checked', { when: format.absolute(data.checkedAt) })}
              </p>
              <dl className="grid grid-cols-3 gap-4 px-6 py-4 max-narrow:grid-cols-2 max-narrow:px-4">
                {[
                  [t('admin.accounts'), data.users],
                  [t('admin.admins'), data.admins],
                  [t('admin.suspended'), data.suspendedUsers],
                  [t('admin.workspaces'), data.workspaces],
                  [t('admin.deletionsPending'), data.deletedWorkspaces],
                  [t('admin.used'), format.bytes(Number(data.usedBytes))],
                ].map(([label, value]) => (
                  <div key={label} className="flex min-w-0 flex-col gap-1">
                    <dt className="text-caption text-ink-muted">{label}</dt>
                    <dd className="text-title text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
              <Facts
                items={[
                  [t('admin.version'), data.version],
                  [t('admin.url'), data.appUrl],
                  [t('admin.modules'), data.modules.join(', ') || t('admin.none')],
                  [t('admin.exportFailures'), data.exportFailures],
                ]}
              />
            </SettingsCard>
            <Deployment data={data} />
          </>
        )}
      </QueryState>
    </>
  );
};

const Deployment = ({ data }: { readonly data: ServerOverview }): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <SettingsCard title={t('admin.deployment')} description={t('admin.deploymentHint')}>
      <Facts
        items={[
          [t('admin.storage'), t(`admin.${data.storage}`)],
          [t('admin.push'), t(data.pushConfigured ? 'admin.configured' : 'admin.unconfigured')],
          [
            t('admin.shared'),
            t(data.sharedStateConfigured ? 'admin.configured' : 'admin.unconfigured'),
          ],
        ]}
      />
    </SettingsCard>
  );
};

export const Operations = (): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t, format } = useI18n();
  const query = useQuery({
    queryKey: ['server', 'operations'],
    queryFn: async ({ signal }) => await client.operations(signal),
    retry: false,
  });
  return (
    <QueryState query={query}>
      {(data) => (
        <SettingsCard
          title={t('admin.jobs')}
          description={t('admin.jobsHint')}
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
          <ul>
            {data.jobs.map((job) => (
              <li
                key={job.name}
                className="flex flex-col gap-2 not-last:border-b-hairline border-border-subtle px-6 py-4 max-narrow:px-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-mono text-label text-ink break-all">{job.name}</h3>
                  <span className="text-label text-ink">{t(`admin.job.${job.status}`)}</span>
                </div>
                <p className="text-caption text-ink-muted">
                  {t('admin.lastSuccess')}:{' '}
                  {job.lastSuccessAt === null
                    ? t('admin.job.never')
                    : format.absolute(job.lastSuccessAt)}{' '}
                  · {t('admin.failures')}: {job.consecutiveFailures}
                </p>
              </li>
            ))}
          </ul>
          <p className="px-6 py-4 text-caption text-ink-muted">
            {t('admin.checked', { when: format.absolute(data.checkedAt) })}
          </p>
        </SettingsCard>
      )}
    </QueryState>
  );
};

export const DeploymentInventory = (): React.JSX.Element => {
  const client = useAdministrationClient();
  const query = useQuery({
    queryKey: ['server', 'overview'],
    queryFn: async ({ signal }) => await client.overview(signal),
    retry: false,
  });
  return <QueryState query={query}>{(data) => <Deployment data={data} />}</QueryState>;
};
