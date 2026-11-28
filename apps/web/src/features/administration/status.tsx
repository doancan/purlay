import type { ServerOverview } from '@purlay/types';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { SettingsCard } from '../settings/page';
import { useAdministrationClient } from './context';
import { Facts, QueryState } from './parts';
import { ServerProblems } from './problems';
import { keys } from '../../data/keys';

export const Overview = (): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t, format } = useI18n();
  const query = useQuery({
    queryKey: keys.serverOverview,
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
              {/* The verdict and when it was reached are one statement; the counts below are another. */}
              <div className="flex flex-col gap-1 px-6 py-4 max-narrow:px-4">
                <p role="status" className="flex items-start gap-2 text-body text-ink">
                  {/* A line tall and centred in it, so the glyph stays on the first line when the verdict wraps. */}
                  <span
                    className={cn(
                      'inline-flex h-lh shrink-0 items-center',
                      data.ready ? 'text-success-text' : 'text-warning-text',
                    )}
                  >
                    <Icon name={data.ready ? 'confirm' : 'warning'} size="sm" />
                  </span>
                  {t(data.ready ? 'admin.ready' : 'admin.notReady')}
                </p>
                <p className="text-caption text-ink-muted">
                  {t('admin.checked', { when: format.absolute(data.checkedAt) })}
                </p>
              </div>
              <dl className="grid grid-cols-3 gap-x-6 gap-y-5 border-y-hairline border-border-subtle px-6 py-5 max-narrow:grid-cols-2 max-narrow:px-4">
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
                    <dd className="text-title text-ink tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              <Facts
                items={[
                  [t('admin.version'), data.version],
                  [t('admin.url'), data.appUrl],
                  [t('admin.enabledModules'), data.modules.join(', ') || t('admin.none')],
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
    queryKey: keys.serverOperations,
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
                className="flex flex-col gap-1 not-last:border-b-hairline border-border-subtle px-6 py-4 max-narrow:px-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-mono text-label text-ink break-all">{job.name}</h3>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-pill px-2 text-label',
                      JOB_TONE[job.status],
                    )}
                  >
                    <Icon name={job.status === 'ok' ? 'confirm' : 'warning'} size="sm" />
                    {t(`admin.job.${job.status}`)}
                  </span>
                </div>
                <p className="text-caption text-ink-muted tabular-nums">
                  {t('admin.lastSuccess')}:{' '}
                  {job.lastSuccessAt === null
                    ? t('admin.job.never')
                    : format.absolute(job.lastSuccessAt)}{' '}
                  · {t('admin.failures')}: {job.consecutiveFailures}
                </p>
              </li>
            ))}
          </ul>
          <p className="border-t-hairline border-border-subtle px-6 py-4 text-caption text-ink-muted max-narrow:px-4">
            {t('admin.checked', { when: format.absolute(data.checkedAt) })}
          </p>
        </SettingsCard>
      )}
    </QueryState>
  );
};

/** A job's state as a tone and a mark as well as its words: a list of sixteen "never succeeded" must not read as calm. */
const JOB_TONE = {
  ok: 'bg-success-subtle text-success-text',
  never: 'bg-warning-subtle text-warning-text',
  overdue: 'bg-danger-subtle text-danger-text',
} as const;

export const DeploymentInventory = (): React.JSX.Element => {
  const client = useAdministrationClient();
  const query = useQuery({
    queryKey: keys.serverOverview,
    queryFn: async ({ signal }) => await client.overview(signal),
    retry: false,
  });
  return <QueryState query={query}>{(data) => <Deployment data={data} />}</QueryState>;
};
