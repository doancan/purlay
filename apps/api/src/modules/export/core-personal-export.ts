/**
 * What the core puts in a person's export of their own data (D-241, D-250): their account, the workspaces their
 * rows name, and their memberships. What the modules add comes after, which is the order a reader wants: who,
 * where, then what they did there.
 *
 * - **Their own row, every field**: what the server holds about who they are and how they sign in. None of it
 *   is a secret — the password's hash, the second step's key and the sessions' tokens live in other tables.
 * - **A workspace their rows name**: enough to say which it was.
 * - Credentials, other people's records and the server's own bookkeeping never go.
 */
import { sql } from '@purlay/db';
import { personalTableExport, type CorePersonalContribution } from './personal-catalogue';

const head = [
  personalTableExport(
    'users',
    {
      id: 'export',
      username: 'export',
      display_name: 'export',
      avatar_url: 'export',
      email: 'export',
      admission_state: 'export',
      admission_requires_verified_email: 'export',
      email_verified: 'export',
      github_id: 'export',
      github_login: 'export',
      github_connected_at: 'export',
      google_made: 'export',
      away_chosen: 'export',
      title: 'export',
      time_zone: 'export',
      status_text: 'export',
      locale: 'export',
      quiet_from: 'export',
      quiet_to: 'export',
      quiet_days: 'export',
      // Since when they asked to be mailed about what they missed (D-240): a setting of theirs.
      missed_mail_since: 'export',
      two_factor_enabled: 'export',
      is_server_admin: 'export',
      suspended_at: 'export',
      last_seen_at: 'export',
      created_at: 'export',
      updated_at: 'export',
      deleted_at: 'export',
    },
    (userId) => ({ where: sql`id = ${userId}`, order: 'id' }),
  ),
  personalTableExport(
    'workspaces',
    {
      id: 'export',
      name: 'export',
      slug: 'export',
      created_at: 'omit',
      created_by: 'omit',
      avatar_url: 'omit',
      updated_at: 'omit',
      deleted_at: 'omit',
      retention_days: 'omit',
      storage_quota_bytes: 'omit',
      storage_used_bytes: 'omit',
      purge_started_at: 'omit',
      purged_at: 'omit',
    },
    (_, workspaces) => ({ where: sql`id in (${workspaces})`, order: 'id' }),
  ),
  personalTableExport(
    'workspace_members',
    {
      id: 'export',
      workspace_id: 'export',
      user_id: 'export',
      role: 'export',
      joined_at: 'export',
      deep_work_until: 'export',
      is_deep_work_active: 'export',
    },
    (userId) => ({ where: sql`user_id = ${userId}`, order: 'id' }),
  ),
  personalTableExport(
    'inbox_entries',
    {
      id: 'export',
      workspace_id: 'export',
      user_id: 'export',
      module: 'export',
      kind: 'export',
      // Another person's id: nobody else's anything rides in a person's own export.
      actor_id: 'omit',
      subject_type: 'export',
      subject_id: 'export',
      params: 'export',
      read_at: 'export',
      created_at: 'export',
    },
    (userId) => ({ where: sql`user_id = ${userId}`, order: 'id' }),
  ),
  personalTableExport(
    'workspace_invitation_recipients',
    {
      id: 'export',
      workspace_id: 'export',
      email: 'export',
      locale: 'export',
      created_by: 'omit',
      created_at: 'export',
      applicant_user_id: 'export',
      requested_at: 'export',
      joined_at: 'export',
    },
    (userId) => ({
      where: sql`applicant_user_id = ${userId} or email = (select lower(trim(email)) from users where id = ${userId} and email_verified = true)`,
      order: 'id',
    }),
  ),
  personalTableExport(
    'workspace_invitation_mail_attempts',
    {
      id: 'export',
      workspace_id: 'export',
      recipient_id: 'export',
      invitation_id: 'omit',
      created_at: 'export',
      result: 'export',
      finished_at: 'export',
      failure: 'export',
    },
    (userId) => ({
      where: sql`recipient_id in (select id from workspace_invitation_recipients where applicant_user_id = ${userId} or email = (select lower(trim(email)) from users where id = ${userId} and email_verified = true))`,
      order: 'id',
    }),
  ),
] as const;

/** The tables the core writes into a person's export. */
export type CorePersonalWritten = (typeof head)[number]['name'];

export const corePersonalExport: CorePersonalContribution = {
  id: 'core',
  head,
  tail: [],
  tables: [],
  workspaces: (userId) => [
    sql`select workspace_id from workspace_members where user_id = ${userId}`,
    sql`select workspace_id from inbox_entries where user_id = ${userId}`,
    sql`select workspace_id from workspace_invitation_recipients where applicant_user_id = ${userId} or email = (select lower(trim(email)) from users where id = ${userId} and email_verified = true)`,
  ],
};

/** The tables of the core that are not in a person's export, and why. Every other table says it in its own module's. */
export type CorePersonalExcluded =
  | 'accounts'
  | 'verifications'
  | 'two_factors'
  | 'sessions'
  | 'push_subscriptions'
  | 'native_authorizations'
  | 'invitation_passports'
  | 'admin_email_verification'
  | 'rate_limits'
  | 'audit_log'
  | 'server_audit_log'
  | 'workspace_invitations'
  | 'job_runs'
  | 'object_deletions'
  | 'workspace_exports'
  | 'personal_exports'
  | 'server_operational_status'
  | 'server_settings'
  | 'setup_state';

export const CORE_PERSONAL_EXCLUDED: Readonly<Record<CorePersonalExcluded, string>> = {
  accounts: 'a provider’s account and a password’s hash: a credential (GitHub’s id is on `users`)',
  verifications: 'short-lived sign-in tokens: credentials',
  two_factors: 'an authenticator’s sealed key and the backup codes: a credential (D-236)',
  sessions: 'a credential; where they are signed in is listed in Sessions & account (D-193)',
  push_subscriptions: 'a device’s keys: a credential of the browser’s',
  native_authorizations: 'digests of one-time codes: credentials (D-191)',
  invitation_passports: 'digests of a cookie or an address: credentials (D-179 §5)',
  admin_email_verification: 'the digest of a link that verifies an address: a credential',
  rate_limits: 'counters by client address or digest, nobody’s record',
  audit_log: 'a workspace’s trail: its owners’ record, not the person’s',
  server_audit_log: 'the server’s trail: the operator’s record',
  workspace_invitations: 'a workspace’s links and their digests: the workspace’s, and credentials',
  job_runs: 'the scheduler’s own record',
  object_deletions: 'storage keys waiting to be deleted: keys never leave',
  workspace_exports: 'an owner’s export of a workspace: the workspace’s record',
  personal_exports:
    'the record of this very export and the ones before it: its archive is the export',
  server_operational_status: 'the operator’s bounded checks, not personal or workspace data',
  server_settings: 'the operator’s settings for the whole server',
  setup_state: 'where the server’s setup stands: the server’s',
};
