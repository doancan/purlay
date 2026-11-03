/**
 * Who owns each table (D-250, `MODULES.md` §5): the core, or one module. A foreign key goes from a module to
 * the core and never the other way, nor between modules, so that a module's tables can be left inert without
 * the core's pointing at them. `table-ownership.integration.test.ts` holds this list to the database.
 */
export type TableOwner = 'core' | 'chat' | 'issues';

export const TABLE_OWNERS: Readonly<Record<string, TableOwner>> = {
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
 * The foreign keys that break the rule today, as `child -> parent`. **This list may only shrink**: the test
 * fails for a key that is not here, and for one that is here and no longer exists, so removing a line is
 * what a fix looks like. Steps 6–10 of the plan empty it.
 */
export const CROSS_OWNER_FOREIGN_KEYS: readonly string[] = ['attachments -> messages'];
