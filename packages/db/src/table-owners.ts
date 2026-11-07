/**
 * Who owns each table (D-250, `MODULES.md` §5): the core, or one module. A foreign key goes from a module to
 * the core and never the other way, nor between modules, so that a module's tables can be left inert without
 * the core's pointing at them. `table-ownership.integration.test.ts` holds this list to the database, and the
 * keys to the rule: it has no exceptions (the last, `attachments -> messages`, went with `chat/0005`).
 *
 * An owner is the core or the id of a migration set (`PRODUCT_MIGRATION_SETS`), so there is no list of module names to
 * keep beside the sets: a module whose tables are in the list has a set, and a set is a module of the build
 * (`composition.test.ts` holds the sets to the bundled modules). Every table of the schema must be in the list, or the
 * file does not compile.
 */
import type { PRODUCT_MIGRATION_SETS } from './migrator';
import type { DB } from './schema';
export type TableOwner = 'core' | (typeof PRODUCT_MIGRATION_SETS)[number]['id'];

export const TABLE_OWNERS = {
  // Identity, tenancy, and what the core keeps for every module.
  accounts: 'core',
  admin_email_verification: 'core',
  attachments: 'core',
  audit_log: 'core',
  // The notices of any module for one person, written through the `NotificationSink` port (D-286).
  inbox_entries: 'core',
  invitation_passports: 'core',
  job_runs: 'core',
  native_authorizations: 'core',
  object_deletions: 'core',
  // The facts one module tells another, a row for each consumer (D-287): only `platform/outbox*.ts` names it.
  outbox: 'core',
  personal_exports: 'core',
  push_subscriptions: 'core',
  rate_limits: 'core',
  server_audit_log: 'core',
  server_settings: 'core',
  server_operational_status: 'core',
  sessions: 'core',
  setup_state: 'core',
  two_factors: 'core',
  users: 'core',
  verifications: 'core',
  workspace_exports: 'core',
  workspace_invitations: 'core',
  workspace_invitation_recipients: 'core',
  workspace_invitation_mail_attempts: 'core',
  workspace_members: 'core',
  workspaces: 'core',

  // Chat: channels and what is said in them, and the integrations that post into them.
  channel_bookmarks: 'chat',
  // Why a person left or was taken out of a channel, for the refusal of their own `SUBSCRIBE` (D-264).
  channel_departures: 'chat',
  channel_members: 'chat',
  channels: 'chat',
  github_app_deliveries: 'chat',
  github_app_handshakes: 'chat',
  github_app_installations: 'chat',
  github_deliveries: 'chat',
  github_integrations: 'chat',
  github_links: 'chat',
  github_operations: 'chat',
  github_repo_feeds: 'chat',
  github_user_authorizations: 'chat',
  incident_responders: 'chat',
  incident_updates: 'chat',
  incidents: 'chat',
  incoming_webhooks: 'chat',
  link_previews: 'chat',
  mentions: 'chat',
  // Written only by messages (a mention, a reply) and pointing at channels and messages: chat's own inbox. A
  // generic core inbox waits for a second module that writes to it.
  notifications: 'chat',
  message_versions: 'chat',
  // Which message a file was sent with: made in chat's own migration set, with keys to the core's `attachments` and
  // to chat's `messages`, so no key runs from the core to chat (`MODULES.md` §10, step 8).
  message_attachments: 'chat',
  messages: 'chat',
  // A person's own drafts, reminders and messages deleted for them alone (chat's set, 0002–0004).
  hidden_messages: 'chat',
  message_reminders: 'chat',
  scheduled_message_attachments: 'chat',
  scheduled_messages: 'chat',
  missed_mail_letters: 'chat',
  pinned_messages: 'chat',
  reactions: 'chat',
  saved_messages: 'chat',
  saved_searches: 'chat',
  thread_follows: 'chat',
  thread_reads: 'chat',
  channel_read_scopes: 'chat',
  channel_groups: 'chat',
  channel_group_channels: 'chat',

  // Issues: a workspace's issues (its own set, `migrations/issues/`).
  issues: 'issues',
} as const satisfies Readonly<Record<keyof DB, TableOwner>>;

/** The tables one owner has, as a union of their names: what a module's handle is made of (`module-db.ts`). */
export type TablesOf<Owner extends TableOwner> = {
  [Table in keyof typeof TABLE_OWNERS]: (typeof TABLE_OWNERS)[Table] extends Owner ? Table : never;
}[keyof typeof TABLE_OWNERS];

/**
 * The columns of a core table that a module's set may add, drop or change, as `table.column`: the expand and the
 * contract of a link that moves into a module (`MODULES.md` §10, step 8), and nothing else, because a module adds
 * its own tables and leaves the core's as they are. **This list may only shrink** once the link is done: the cells
 * test (`migration-cells.integration.test.ts`) fails for a change that is not here.
 */
export const CORE_COLUMNS_A_SET_CHANGES: readonly string[] = [
  'attachments.message_id',
  'attachments.channel_id',
];

/** A column of a core table that exists for one module (`MODULES.md` §5, D-275). */
export interface CoreColumnForAModule {
  /** The module the column is for: its own files may name it, and the core's only where `coreFiles` says. */
  readonly module: Exclude<TableOwner, 'core'>;
  readonly why: string;
  /**
   * The core's files that may name the column, as paths from `apps/api/src`: the route that sets it, the erasure that
   * clears it, the export that lists it. A file outside this list that names it fails `core-columns.test.ts`.
   */
  readonly coreFiles: readonly string[];
}

/**
 * The columns of core tables that only one module uses, as `table.column`: kept where they are, because moving them is a
 * migration with a risk and nobody feels the pain (D-275). **This list may only shrink**: a module adds no column to a
 * core table (the cells test and `core-columns.test.ts` refuse it), `core-columns.test.ts` fixes its length, and a column
 * that moves to a table of its module's own is deleted from here in the change that moves it. D-275 says when one must.
 */
export const CORE_COLUMNS_FOR_A_MODULE: Readonly<Record<string, CoreColumnForAModule>> = {
  'server_settings.github_app_client_id': {
    module: 'chat',
    why: 'the id of the GitHub App chat’s integration signs in as; the Administration page that keeps it is the core’s',
    coreFiles: ['modules/setup/settings.ts'],
  },
  'server_settings.github_app_client_secret_encrypted': {
    module: 'chat',
    why: 'the GitHub App’s client secret, sealed; read by chat’s integration, kept by the core’s Administration page',
    coreFiles: ['modules/setup/settings.ts'],
  },
  'server_settings.github_app_id': {
    module: 'chat',
    why: 'the number of the GitHub App chat’s integration is installed as',
    coreFiles: ['modules/setup/settings.ts'],
  },
  'server_settings.github_app_private_key_encrypted': {
    module: 'chat',
    why: 'the GitHub App’s private key, sealed, with which chat’s integration asks for installation tokens',
    coreFiles: ['modules/setup/settings.ts'],
  },
  'server_settings.github_app_slug': {
    module: 'chat',
    why: 'the GitHub App’s address on GitHub, which chat’s integration links people to',
    coreFiles: ['modules/setup/settings.ts'],
  },
  'server_settings.github_app_webhook_secret_encrypted': {
    module: 'chat',
    why: 'the secret GitHub signs chat’s webhook deliveries with, sealed',
    coreFiles: ['modules/setup/settings.ts'],
  },
  'users.away_chosen': {
    module: 'chat',
    why: 'whether the person chose to show as away, which chat’s presence shows to the others',
    coreFiles: [
      'modules/users/away.ts',
      'modules/workspaces/workspaces.ts',
      'modules/export/core-export.ts',
      'modules/export/core-personal-export.ts',
    ],
  },
  'users.missed_mail_since': {
    module: 'chat',
    why: 'the instant from which chat’s missed-mail job counts what waited unread for the person, and the one write chat makes to a core row',
    coreFiles: [
      'modules/users/erasure.ts',
      'modules/export/core-export.ts',
      'modules/export/core-personal-export.ts',
    ],
  },
  'users.quiet_days': {
    module: 'chat',
    why: 'the days of the week of the person’s quiet hours, which hold back chat’s push and mail',
    coreFiles: [
      'modules/users/quiet-hours.ts',
      'modules/workspaces/deep-work.ts',
      'modules/export/core-export.ts',
      'modules/export/core-personal-export.ts',
    ],
  },
  'users.quiet_from': {
    module: 'chat',
    why: 'the hour the person’s quiet hours begin, which hold back chat’s push and mail',
    coreFiles: [
      'modules/users/quiet-hours.ts',
      'modules/workspaces/deep-work.ts',
      'modules/export/core-export.ts',
      'modules/export/core-personal-export.ts',
    ],
  },
  'users.quiet_to': {
    module: 'chat',
    why: 'the hour the person’s quiet hours end, which hold back chat’s push and mail',
    coreFiles: [
      'modules/users/quiet-hours.ts',
      'modules/workspaces/deep-work.ts',
      'modules/export/core-export.ts',
      'modules/export/core-personal-export.ts',
    ],
  },
  'workspace_members.deep_work_until': {
    module: 'chat',
    why: 'when the person’s Deep Work ends, which chat’s notifications and reminders wait for',
    coreFiles: [
      'modules/workspaces/deep-work.ts',
      'modules/workspaces/workspaces.ts',
      'modules/export/core-export.ts',
      'modules/export/core-personal-export.ts',
    ],
  },
  'workspace_members.is_deep_work_active': {
    module: 'chat',
    why: 'whether the person is in Deep Work, which holds back chat’s notifications',
    coreFiles: [
      'modules/workspaces/deep-work.ts',
      'modules/workspaces/workspaces.ts',
      'modules/export/core-export.ts',
      'modules/export/core-personal-export.ts',
    ],
  },
  'workspaces.retention_days': {
    module: 'chat',
    why: 'how many days of messages chat’s purge keeps, set from the core’s workspace settings',
    coreFiles: [
      'modules/workspaces/retention.ts',
      'modules/export/core-export.ts',
      'modules/export/core-personal-export.ts',
    ],
  },
};

/**
 * The enum types of the core that a module's set may alter, as `set:type`: `ALTER TYPE ... ADD VALUE` changes
 * what the core's columns accept without changing a column, so `CORE_COLUMNS_A_SET_CHANGES` does not see it. The
 * cells test fails for a change that is not here, and the entry names the set, so another set altering the same
 * type fails too. **This list may only shrink**: `chat:notification_type` is the one that exists today
 * (`migrations/chat/0003_message_reminders.sql` adds `'reminder'` to the core's `notifications.type`).
 */
export const CORE_ENUMS_A_SET_CHANGES: readonly string[] = ['chat:notification_type'];
