/**
 * What becomes of each table's rows when a person's account is erased, and how long they live (D-27, D-139, D-250).
 * Beside the export's decision (`excluded` and the contributions, `MODULES.md` §5) and the workspace purge's
 * (`WorkspacePurge.tables`), this is the third: a table that is in the schema and not here does not compile, and
 * `table-lifecycle.test.ts` holds the list to `TABLE_OWNERS`. A module that adds a table decides both here, in
 * the same change as the migration; `DATA.md` §2 says it in prose for the operator, and is not what holds it.
 *
 * A decision describes what the code does, not what it should: `{ gap }` is for a table whose erasure does not reach
 * a person's rows today, so it is a known list that the test spells out and that only shrinks, not a silent one.
 */
import type { DB } from './schema';

/** What the account's erasure (`eraseAccount` and the `userErased` hooks) does to the rows that name the person. */
type Erasure =
  /** The person's rows are deleted, in the erasure's transaction or by a key that cascades from a row it deletes. */
  | 'deleted'
  /**
   * The rows stay and name only the anonymised account (or a column is cleared): the team's record, not the person's.
   * Erasure soft-deletes the `users` row, so no `ON DELETE SET NULL` or `CASCADE` key to it ever fires: a column that
   * says who made, added, pinned or declared something keeps naming the anonymised account (D-256), and a row that
   * hangs on the person stays unless a step of the erasure or a `userErased` hook deletes it.
   */
  | 'anonymised'
  /** The table holds nothing that names a person; the reason is said. */
  | { readonly nobody: string }
  /** The erasure does not reach the person's rows, though they are personal: and why. */
  | { readonly gap: string };

/** How long rows are kept. */
type Retention =
  /** The workspace's history window deletes them (`purge:retention`, D-139). */
  | 'window'
  /** A scheduled job deletes them once they are past a time that the table's own columns say. */
  | 'swept'
  /** They go with the row they hang on, by a key that cascades or by the step that deletes that row. */
  | 'with-parent'
  /** Until a person or an owner removes them, or the thing they are about ends. */
  | 'until-removed'
  /** Nothing deletes them on a schedule, and why that is intended. */
  | { readonly kept: string };

export interface TableLifecycle {
  readonly erasure: Erasure;
  readonly retention: Retention;
}

const decided = (erasure: Erasure, retention: Retention): TableLifecycle => ({
  erasure,
  retention,
});

export const TABLE_LIFECYCLE: Readonly<Record<keyof DB, TableLifecycle>> = {
  // Core.
  accounts: decided('deleted', 'until-removed'),
  admin_email_verification: decided('deleted', 'swept'),
  attachments: decided('anonymised', 'window'),
  audit_log: decided('anonymised', { kept: 'the workspace’s trail of who changed what' }),
  invitation_passports: decided('deleted', 'swept'),
  job_runs: decided(
    { nobody: 'when each job last ran' },
    { kept: 'one row per job, replaced at each run' },
  ),
  native_authorizations: decided('deleted', 'swept'),
  object_deletions: decided({ nobody: 'storage keys waiting to be deleted' }, 'swept'),
  personal_exports: decided('anonymised', {
    kept: 'the row, ids and times only, is the record that it was made',
  }),
  push_subscriptions: decided('deleted', 'until-removed'),
  rate_limits: decided('deleted', 'swept'),
  // The actor stays, naming the anonymised account: the key's SET NULL never fires on a soft deletion (D-256).
  server_audit_log: decided('anonymised', {
    kept: 'append-only trail of the server’s own settings',
  }),
  server_settings: decided(
    { nobody: 'the server’s own settings, one row' },
    { kept: 'one row for the life of the instance' },
  ),
  sessions: decided('deleted', 'swept'),
  setup_state: decided(
    {
      nobody:
        'digests of the setup’s one-time code and the id of the administrator it made, one row',
    },
    { kept: 'one row for the life of the instance' },
  ),
  two_factors: decided('deleted', 'until-removed'),
  users: decided('anonymised', 'until-removed'),
  verifications: decided('deleted', 'swept'),
  workspace_exports: decided('anonymised', {
    kept: 'the row is the record that an export was made; its archive is swept',
  }),
  workspace_invitations: decided('anonymised', {
    kept: 'the record of what was offered, for the life of the workspace',
  }),
  workspace_members: decided('anonymised', 'until-removed'),
  workspaces: decided('anonymised', {
    kept: 'the row stays, with its name, as what the trails refer to',
  }),

  // Chat.
  // `added_by` stays, naming the anonymised account: the key's SET NULL never fires on a soft deletion (D-256).
  channel_bookmarks: decided('anonymised', 'until-removed'),
  channel_members: decided('anonymised', 'until-removed'),
  channels: decided('anonymised', { kept: 'for the life of the workspace' }),
  github_app_deliveries: decided({ nobody: 'a delivery’s id and its body’s digest' }, 'swept'),
  github_app_handshakes: decided('anonymised', 'swept'),
  // `connected_by` stays, naming the anonymised account (D-256). `account_login` is the GitHub login of the account
  // the App was installed on, and for a personal one (`account_type = 'User'`) it is the person's: nothing clears it.
  github_app_installations: decided(
    {
      gap: 'account_login is the person’s GitHub login when the App is installed on their personal account, and the erasure does not clear it, nor the audit metadata that names it (#997)',
    },
    'until-removed',
  ),
  github_deliveries: decided({ nobody: 'a delivery’s id and its body’s digest' }, 'swept'),
  github_integrations: decided('anonymised', 'until-removed'),
  github_links: decided('anonymised', 'with-parent'),
  github_operations: decided('anonymised', 'swept'),
  github_repo_feeds: decided('anonymised', 'until-removed'),
  // Deleted by the chat module's `userErased` hook. The token itself stays valid at GitHub until the person revokes the
  // App there: nothing calls GitHub to revoke it.
  github_user_authorizations: decided('deleted', 'until-removed'),
  incident_responders: decided('anonymised', 'with-parent'),
  incident_updates: decided('anonymised', 'with-parent'),
  incidents: decided('anonymised', { kept: 'for the life of the channel' }),
  incoming_webhooks: decided('anonymised', 'until-removed'),
  link_previews: decided({ nobody: 'a GitHub item’s public title and state' }, 'swept'),
  mentions: decided('anonymised', 'with-parent'),
  notifications: decided('deleted', 'with-parent'),
  message_versions: decided('anonymised', 'with-parent'),
  message_attachments: decided({ nobody: 'ids only' }, 'with-parent'),
  messages: decided('anonymised', 'window'),
  hidden_messages: decided('deleted', 'with-parent'),
  message_reminders: decided('deleted', 'until-removed'),
  scheduled_message_attachments: decided('deleted', 'with-parent'),
  scheduled_messages: decided('deleted', 'swept'),
  missed_mail_letters: decided('deleted', 'swept'),
  pinned_messages: decided('anonymised', 'with-parent'),
  reactions: decided('anonymised', 'with-parent'),
  saved_messages: decided('deleted', 'until-removed'),
  saved_searches: decided('deleted', 'until-removed'),
  thread_follows: decided('deleted', 'until-removed'),

  // Issues.
  issues: decided('anonymised', 'until-removed'),
};
