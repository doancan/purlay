/**
 * What the core puts in a workspace's export (D-27 §3, D-140, D-250): the workspace, its members, the people the
 * rows name, its invitations and its trail, bounded to the workspace by their own keys. What the modules add sits
 * between the first three and the last two, which is the order a reader re-importing the files wants.
 *
 * - **Credentials and secrets never go**: sessions, sign-in links, devices, an invitation's token digest.
 * - **People**: everyone the exported rows name, by the public projection (`User`); the address and the profile
 *   only for current members — a former member's were set after they left (D-140).
 * - Operational tables — caches, job records, the migrator's — are nobody's record.
 */
import { sql } from '@purlay/db';
import { tableExport, type CoreExportContribution } from './catalogue';

const head = [
  tableExport(
    'workspaces',
    {
      id: 'export',
      name: 'export',
      slug: 'export',
      avatar_url: 'export',
      created_at: 'export',
      created_by: 'export',
      updated_at: 'export',
      deleted_at: 'export',
      retention_days: 'export',
      storage_quota_bytes: 'export',
      storage_used_bytes: 'export',
      // The deletion's job (D-242): null in every workspace that can still be exported.
      purge_started_at: 'omit',
      purged_at: 'omit',
    },
    (s) => ({ where: sql`id = ${s.workspaceId}`, order: 'id' }),
  ),
  tableExport(
    'users',
    {
      id: 'export',
      username: 'export',
      display_name: 'export',
      avatar_url: 'export',
      created_at: 'export',
      deleted_at: 'export',
      // The controller's data about their own people — not about those who left (D-140).
      email: 'operator',
      title: 'members',
      time_zone: 'members',
      status_text: 'members',
      // Identity with another service, and a person's own settings and traces.
      github_id: 'omit',
      github_login: 'omit',
      github_connected_at: 'omit',
      google_made: 'omit',
      away_chosen: 'omit',
      // What the sign-in library keeps about the account, and who may run the server: the person's own,
      // and a credential's neighbour, never the controller's data about them (D-179).
      email_verified: 'omit',
      is_server_admin: 'omit',
      // The server's administrator's decision about the account (D-233): the server's, not the workspace's.
      suspended_at: 'omit',
      // Whether a password sign-in asks for a second step (D-236): a credential's neighbour, the person's own.
      two_factor_enabled: 'omit',
      // A person's own setting about when they are interrupted (D-234), as Deep Work is.
      quiet_from: 'omit',
      quiet_to: 'omit',
      quiet_days: 'omit',
      // Whether the person asked for email about what they missed (D-240): their own setting, as quiet hours.
      missed_mail_since: 'omit',
      locale: 'omit',
      last_seen_at: 'omit',
      updated_at: 'omit',
    },
    (_, people) => ({ where: sql`id in (${people})`, order: 'id' }),
  ),
  tableExport(
    'workspace_members',
    {
      id: 'export',
      workspace_id: 'export',
      user_id: 'export',
      role: 'export',
      joined_at: 'export',
      // A person's own state.
      deep_work_until: 'omit',
      is_deep_work_active: 'omit',
    },
    (s) => ({ where: sql`workspace_id = ${s.workspaceId}`, order: 'id' }),
  ),
] as const;

const tail = [
  tableExport(
    'workspace_invitations',
    {
      id: 'export',
      workspace_id: 'export',
      created_by: 'export',
      created_at: 'export',
      expires_at: 'export',
      revoked_at: 'export',
      // The link's secret, digested: it would still open nothing, and says nothing either.
      token_hash: 'omit',
    },
    (s) => ({ where: sql`workspace_id = ${s.workspaceId}`, order: 'id' }),
  ),
  tableExport(
    'audit_log',
    {
      id: 'export',
      workspace_id: 'export',
      actor_user_id: 'export',
      action: 'export',
      target_type: 'export',
      target_id: 'export',
      metadata: 'export',
      created_at: 'export',
      // A session is a credential's row, not exported: the id would name nothing.
      session_id: 'omit',
    },
    (s) => ({ where: sql`workspace_id = ${s.workspaceId}`, order: 'id' }),
  ),
] as const;

/** The tables the core writes into an export. */
export type CoreWritten = (typeof head)[number]['name'] | (typeof tail)[number]['name'];

export const coreExport: CoreExportContribution = {
  id: 'core',
  head,
  tail,
  tables: [],
  people: (scope) => [
    sql`select user_id from workspace_members where workspace_id = ${scope.workspaceId}`,
    sql`select created_by from workspaces where id = ${scope.workspaceId}`,
    sql`select actor_user_id from audit_log where workspace_id = ${scope.workspaceId}`,
    sql`select created_by from workspace_invitations where workspace_id = ${scope.workspaceId}`,
  ],
};

/** The tables of the core that are not in an export, and why. Every other table says it in its own module's. */
export type CoreExcluded =
  | 'accounts'
  | 'verifications'
  | 'two_factors'
  | 'rate_limits'
  | 'sessions'
  | 'push_subscriptions'
  | 'job_runs'
  | 'workspace_exports'
  | 'personal_exports'
  | 'object_deletions'
  | 'server_settings'
  | 'server_audit_log'
  | 'admin_email_verification'
  | 'invitation_passports'
  | 'native_authorizations'
  | 'setup_state';

export const CORE_EXCLUDED: Readonly<Record<CoreExcluded, string>> = {
  accounts: 'a provider’s account and a credential’s password hash: the person’s own (D-179)',
  verifications: 'short-lived sign-in tokens, credentials of the person’s own (D-179)',
  two_factors:
    'an authenticator app’s sealed key and the backup codes: a second credential, the person’s own (D-236)',
  rate_limits:
    'sign-in and invitation-mail counters by client address, address digest or id, nobody’s record (D-179)',
  sessions: 'a credential, the person’s own',
  push_subscriptions: 'a device’s keys, the person’s own',
  job_runs: 'the scheduler’s own record',
  workspace_exports: 'an export’s own record: its archive is the export',
  personal_exports:
    'a person’s export of their own data: theirs, never a workspace’s (D-241), and its archive is the export',
  object_deletions:
    'storage keys waiting to be deleted: the store’s housekeeping, and keys never leave',
  server_settings:
    'the operator’s settings for the whole server, not a workspace’s; the GitHub secret and the relay’s address are credentials, which never leave (D-179)',
  server_audit_log:
    'who changed which of the server’s own settings, and when, and which deleted workspace was erased: the operator’s trail, not a workspace’s, and never exported (D-179 §4.8, D-242)',
  admin_email_verification:
    'the digest of the one link that verifies the setup administrator’s address: a credential, the server’s, never exported (D-179 §4.3)',
  invitation_passports:
    'digests of a cookie or of an address, each made from a live invitation link and spent by one sign-up: credentials, never exported (D-179 §5)',
  native_authorizations:
    'digests of one-time codes that hand a person’s session to the native application, and the challenge each is bound to: credentials, the person’s own, never exported (D-191)',
  setup_state:
    'where the server’s setup stands: digests of its one-time code and its claim, the throttle and the step reached — the server’s, not a workspace’s, and never exported (D-179 §4)',
};
