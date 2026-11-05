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

export const TABLE_OWNERS: Readonly<Record<keyof DB, TableOwner>> = {
  // Identity, tenancy, and what the core keeps for every module.
  accounts: 'core',
  admin_email_verification: 'core',
  attachments: 'core',
  audit_log: 'core',
  invitation_passports: 'core',
  job_runs: 'core',
  native_authorizations: 'core',
  object_deletions: 'core',
  personal_exports: 'core',
  push_subscriptions: 'core',
  rate_limits: 'core',
  server_audit_log: 'core',
  server_settings: 'core',
  sessions: 'core',
  setup_state: 'core',
  two_factors: 'core',
  users: 'core',
  verifications: 'core',
  workspace_exports: 'core',
  workspace_invitations: 'core',
  workspace_members: 'core',
  workspaces: 'core',

  // Chat: channels and what is said in them, and the integrations that post into them.
  channel_bookmarks: 'chat',
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

  // Issues: a workspace's issues (its own set, `migrations/issues/`).
  issues: 'issues',
};

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

/**
 * The enum types of the core that a module's set may alter, as `set:type`: `ALTER TYPE ... ADD VALUE` changes
 * what the core's columns accept without changing a column, so `CORE_COLUMNS_A_SET_CHANGES` does not see it. The
 * cells test fails for a change that is not here, and the entry names the set, so another set altering the same
 * type fails too. **This list may only shrink**: `chat:notification_type` is the one that exists today
 * (`migrations/chat/0003_message_reminders.sql` adds `'reminder'` to the core's `notifications.type`).
 */
export const CORE_ENUMS_A_SET_CHANGES: readonly string[] = ['chat:notification_type'];
