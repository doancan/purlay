import type { ServerOverview } from '@purlay/types';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useI18n } from '../../i18n/i18n-provider';
import { Link } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Disclosure } from '../../ui/disclosure';
import { SettingsCard } from '../settings/page';
import { useAdministrationClient } from './context';
import { keys } from '../../data/keys';

/** Read-only operational reports: server policy decides job and backup freshness. */
export const ServerProblems = ({
  overview,
}: {
  readonly overview: UseQueryResult<ServerOverview>;
}): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t, format } = useI18n();
  const operations = useQuery({
    queryKey: keys.serverOperations,
    queryFn: async ({ signal }) => await client.operations(signal),
    retry: false,
  });
  const backups = useQuery({
    queryKey: keys.serverBackups,
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
        className="flex flex-col gap-1 not-first:border-t-hairline border-border-subtle px-6 py-4 max-narrow:px-4"
      >
        <h3 className="text-label text-ink break-words">{title}</h3>
        <div className="text-body text-ink-muted break-words">{detail}</div>
        <Link
          className="self-start rounded-sm py-1 text-label text-accent-text hover:underline"
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
      <Disclosure
        className="text-label"
        summary={t('admin.problems.jobCount', { count: jobs.length })}
      >
        {/* Drawn as Operations draws a job: its name as code, its state as the line under it. */}
        <ul className="flex flex-col gap-3 pt-2 pb-1">
          {jobs.map((job) => (
            <li key={job.name} className="flex flex-col">
              <span className="font-mono text-label text-ink break-all">{job.name}</span>
              <span className="text-caption text-ink-muted tabular-nums">
                {t(`admin.job.${job.status}`)} · {t('admin.failures')}: {job.consecutiveFailures}
              </span>
            </li>
          ))}
        </ul>
      </Disclosure>,
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
  if (overview.data !== undefined) {
    const { outboxDeadFacts: dead, outboxOldestPendingSeconds: waited } = overview.data;
    const stale = waited > overview.data.outboxStaleAfterSeconds;
    if (dead > 0 || stale) {
      entry(
        'outbox',
        t('admin.problems.outbox'),
        <>
          {dead > 0 ? <p>{t('admin.problems.outboxDead', { count: dead })}</p> : null}
          {stale ? (
            <p>{t('admin.problems.outboxStale', { minutes: Math.floor(waited / 60) })}</p>
          ) : null}
        </>,
        'operations',
        t('admin.problems.openOperations'),
        dead + (stale ? 1 : 0),
      );
    }
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
      {problems.length > 0 && (
        <ul className="border-t-hairline border-border-subtle">{problems}</ul>
      )}
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
