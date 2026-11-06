import { sql, type Executor } from '@purlay/db';
import type { ServerMailStatus, ServerOperations, ServerOverview } from '@purlay/types';
import type { ServerAdminSession } from '../setup/setup';
import { jobStatus, STALE_AFTER_MS } from '../jobs/report';
import { SERVER_VERSION } from '../../platform/server-version';
import type { Config } from '../../platform/config';

export const serverOperations = async (
  db: Executor,
  _admin: ServerAdminSession,
  jobs: readonly string[],
  now: Date,
): Promise<ServerOperations> => {
  const records = await db
    .selectFrom('job_runs')
    .select([
      'job_name',
      'last_started_at',
      'last_success_at',
      'last_duration_ms',
      'consecutive_failures',
    ])
    .where('job_name', 'in', jobs)
    .execute();
  return {
    checkedAt: now.toISOString(),
    staleAfterMs: STALE_AFTER_MS,
    jobs: jobs.map((name) => {
      const record = records.find((row) => row.job_name === name);
      return {
        name,
        status: jobStatus(record, now),
        lastStartedAt: record?.last_started_at?.toISOString() ?? null,
        lastSuccessAt: record?.last_success_at?.toISOString() ?? null,
        durationMs: record?.last_duration_ms ?? null,
        consecutiveFailures: record?.consecutive_failures ?? 0,
      };
    }),
  };
};

export const serverOverview = async (
  db: Executor,
  _admin: ServerAdminSession,
  config: Config,
  modules: readonly string[],
  ready: boolean,
  now: Date,
): Promise<ServerOverview> => {
  const users = await db
    .selectFrom('users')
    .select([
      sql<string>`count(*)`.as('total'),
      sql<string>`count(*) filter (where is_server_admin and suspended_at is null)`.as('admins'),
      sql<string>`count(*) filter (where suspended_at is not null)`.as('suspended'),
    ])
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  const workspaces = await db
    .selectFrom('workspaces')
    .select([
      sql<string>`count(*) filter (where deleted_at is null)`.as('active'),
      sql<string>`count(*) filter (where deleted_at is not null and purged_at is null)`.as(
        'deleted',
      ),
      sql<string>`coalesce(sum(storage_used_bytes), 0) + (select coalesce(sum(size_bytes), 0) from attachments where claimed_at is null)`.as(
        'used',
      ),
    ])
    .executeTakeFirstOrThrow();
  const failedExports = await db
    .selectFrom('workspace_exports')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('status', '=', 'failed')
    .executeTakeFirstOrThrow();
  return {
    checkedAt: now.toISOString(),
    version: SERVER_VERSION,
    appUrl: config.APP_URL,
    ready,
    modules: [...modules],
    users: Number(users.total),
    admins: Number(users.admins),
    suspendedUsers: Number(users.suspended),
    workspaces: Number(workspaces.active),
    deletedWorkspaces: Number(workspaces.deleted),
    usedBytes: workspaces.used,
    storage:
      config.STORAGE_DIRECTORY !== undefined
        ? 'directory'
        : config.S3_BUCKET !== undefined
          ? 's3'
          : 'unconfigured',
    pushConfigured: config.VAPID_PUBLIC_KEY !== undefined,
    sharedStateConfigured: config.REDIS_URL !== undefined,
    exportFailures: Number(failedExports.count),
  };
};

export const serverMailStatus = async (
  _admin: ServerAdminSession,
  db: Executor,
): Promise<ServerMailStatus> => {
  const row = await db
    .selectFrom('server_operational_status')
    .select(['smtp_tested_at', 'smtp_accepted', 'smtp_reason', 'smtp_host'])
    .where('id', '=', true)
    .executeTakeFirstOrThrow();
  return {
    lastTest:
      row.smtp_tested_at === null || row.smtp_accepted === null || row.smtp_host === null
        ? null
        : {
            testedAt: row.smtp_tested_at.toISOString(),
            accepted: row.smtp_accepted,
            host: row.smtp_host,
            reason: row.smtp_reason,
          },
  };
};
