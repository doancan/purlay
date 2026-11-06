import type { ServerOverview } from '@purlay/types';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useI18n } from '../../i18n/i18n-provider';
import { Link } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { SettingsCard } from '../settings/page';
import { useAdministrationClient } from './context';

/** Read-only operational reports: server policy decides job and backup freshness. */
export const ServerProblems = ({
  overview,
}: {
  readonly overview: UseQueryResult<ServerOverview>;
}): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t, format } = useI18n();
  const operations = useQuery({
    queryKey: ['server', 'operations'],
    queryFn: async ({ signal }) => await client.operations(signal),
    retry: false,
  });
  const backups = useQuery({
    queryKey: ['server', 'backups'],
    queryFn: async ({ signal }) => await client.backups(signal),
    retry: false,
  });
  const sources = [
    { name: t('admin.problems.exports'), query: overview },
    { name: t('admin.jobs'), query: operations },
    { name: t('admin.problems.backups'), query: backups },
  ];
  const checking = sources.some(({ query }) => query.isFetching);
  const incomplete = sources.some(({ query }) => query.isError || query.isPending);
  const problems: React.JSX.Element[] = [];
  let count = 0;
  const entry = (
    key: string,
    title: string,
    detail: React.ReactNode,
    section: 'operations' | 'data',
    label: string,
    size = 1,
  ): void => {
    count += size;
    problems.push(
      <li
        key={key}
        className="flex flex-col gap-2 not-first:border-t-hairline border-border-subtle px-6 py-4 max-narrow:px-4"
      >
        <h3 className="text-label text-ink break-words">{title}</h3>
        <div className="text-body text-ink-muted break-words">{detail}</div>
        <Link
          className="self-start py-2 text-label text-accent-text underline"
          to="serverSection"
          params={{ section }}
        >
          {label}
        </Link>
      </li>,
    );
  };
  const jobs = (operations.data?.jobs ?? []).filter(
    (job) => job.status !== 'ok' || job.consecutiveFailures > 0,
  );
  if (jobs.length > 0) {
    entry(
      'jobs',
      t('admin.jobs'),
      <details>
        <summary className="cursor-pointer py-2 text-label text-ink">
          {t('admin.problems.jobCount', { count: jobs.length })}
        </summary>
        <ul className="flex flex-col gap-3 pt-3">
          {jobs.map((job) => (
            <li key={job.name} className="flex flex-col gap-1">
              <span className="text-label text-ink break-all">{job.name}</span>
              <span>
                {t(`admin.job.${job.status}`)} · {t('admin.failures')}: {job.consecutiveFailures}
              </span>
            </li>
          ))}
        </ul>
      </details>,
      'operations',
      t('admin.problems.openOperations'),
      jobs.length,
    );
  }
  if (backups.data !== undefined && backups.data.state !== 'current') {
    entry(
      'backups',
      t('admin.problems.backups'),
      t(`admin.backup.${backups.data.state}`),
      'operations',
      t('admin.problems.openOperations'),
    );
  }
  if (overview.data !== undefined && overview.data.exportFailures > 0) {
    entry(
      'exports',
      t('admin.problems.exports'),
      t('admin.problems.exportFailures', { count: overview.data.exportFailures }),
      'data',
      t('admin.problems.openData'),
      overview.data.exportFailures,
    );
  }
  return (
    <SettingsCard
      title={t('admin.problems.title')}
      description={t('admin.problems.body')}
      actions={
        <Button
          busy={checking}
          onClick={() => {
            for (const { query } of sources) void query.refetch();
          }}
        >
          {t('admin.refresh')}
        </Button>
      }
    >
      <p role="status" className="px-6 py-4 text-body text-ink max-narrow:px-4">
        {t(
          checking
            ? 'admin.problems.checking'
            : incomplete
              ? 'admin.problems.incomplete'
              : problems.length === 0
                ? 'admin.problems.clear'
                : 'admin.problems.count',
          { count },
        )}
      </p>
      {sources.map(
        ({ name, query }) =>
          query.isError && (
            <div key={name} className="flex flex-wrap items-center gap-3 px-6 py-3 max-narrow:px-4">
              <p role="alert" className="text-body text-danger-text">
                {t('admin.problems.readError', { source: name })}
              </p>
              <Button
                busy={query.isFetching}
                onClick={() => {
                  void query.refetch();
                }}
              >
                {t('common.retry')}
              </Button>
            </div>
          ),
      )}
      {problems.length > 0 && <ul>{problems}</ul>}
      <div className="flex flex-col gap-1 border-t-hairline border-border-subtle px-6 py-4 max-narrow:px-4">
        {sources.map(
          ({ name, query }) =>
            query.data !== undefined && (
              <p key={name} className="text-caption text-ink-muted">
                {name} · {t('admin.checked', { when: format.absolute(query.data.checkedAt) })}
              </p>
            ),
        )}
      </div>
    </SettingsCard>
  );
};
