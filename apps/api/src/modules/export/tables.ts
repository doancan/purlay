/**
 * What a workspace export holds, table by table and column by column (D-27 §3, D-140). Typed over the
 * generated schema (`Database`, D-45): a table or a column a migration adds is a compile error here
 * until somebody decides whether it leaves the server — a secret added later cannot ride out unseen.
 *
 * - **The workspace's own record goes**: its channels, messages and what hangs off them, its incidents,
 *   its trail, its invitations and feeds — each bounded to the workspace, and to the channels the
 *   export covers (every channel for the operator; those the asking owner can see, D-34).
 * - **Each person's own state stays**: saved items, notifications, read positions, stars, notification
 *   levels, Deep Work — a person's, not the workspace's (as D-139 §5 treats them).
 * - **Credentials and secrets never go**: sessions, sign-in links, devices, the sealed GitHub token, a
 *   feed's webhook secret, an invitation's token digest, a storage key.
 * - **People**: everyone the exported rows name, by the public projection (`User`); the address and
 *   the profile only for current members — a former member's were set after they left (D-140).
 * - Operational tables — caches, job records, the migrator's — are nobody's record.
 */
import type { Database } from '@purlay/db';

/** A column: in the export, left out, or — for people — only for current members. */
/**
 * A column: in the export, left out, only for current members, or — the address — only for current
 * members and only in the operator's export (D-140 §3).
 */
type Column = 'export' | 'omit' | 'members' | 'operator';

/** The tables an export writes, one NDJSON file each. */
export type ExportedTable =
  | 'workspaces'
  | 'workspace_members'
  | 'channels'
  | 'channel_members'
  | 'messages'
  | 'reactions'
  | 'mentions'
  | 'message_versions'
  | 'pinned_messages'
  | 'channel_bookmarks'
  | 'github_links'
  | 'attachments'
  | 'incidents'
  | 'incident_updates'
  | 'incident_responders'
  | 'audit_log'
  | 'github_repo_feeds'
  | 'workspace_invitations'
  | 'users';

type Columns = { readonly [T in ExportedTable]: { readonly [C in keyof Database[T]]: Column } };

export const COLUMNS: Columns = {
  workspaces: {
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
  workspace_members: {
    id: 'export',
    workspace_id: 'export',
    user_id: 'export',
    role: 'export',
    joined_at: 'export',
    // A person's own state.
    deep_work_until: 'omit',
    is_deep_work_active: 'omit',
  },
  channels: {
    id: 'export',
    workspace_id: 'export',
    name: 'export',
    topic: 'export',
    type: 'export',
    dm_key: 'export',
    created_by: 'export',
    created_at: 'export',
    updated_at: 'export',
    deleted_at: 'export',
    last_message_at: 'export',
    // How long the channel keeps its history, as the workspace's window goes (D-225).
    min_retention_days: 'export',
    retain_forever: 'export',
    // Who posts a root in it: everybody, or its workspace's owners and admins (D-243).
    only_admins_post: 'export',
    // The realtime layer's ordering, not the record.
    state_version: 'omit',
  },
  channel_members: {
    id: 'export',
    channel_id: 'export',
    user_id: 'export',
    joined_at: 'export',
    // Each person's own reading of the channel.
    last_read_message_id: 'omit',
    notification_level: 'omit',
    starred_at: 'omit',
    unread_count: 'omit',
    unread_mention_count: 'omit',
    state_version: 'omit',
  },
  messages: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    parent_id: 'export',
    sender_id: 'export',
    message_type: 'export',
    content: 'export',
    metadata: 'export',
    created_at: 'export',
    updated_at: 'export',
    edited_at: 'export',
    deleted_at: 'export',
    thread_reply_count: 'export',
    thread_last_reply_at: 'export',
    resolved_at: 'export',
    resolved_by: 'export',
    state_version: 'omit',
    // Bookkeeping for a client catching up (D-194), as the row's version is: not the workspace's data.
    changed_at: 'omit',
    is_question: 'export',
    question_assignee_id: 'export',
    accepted_answer_id: 'export',
    decision_note: 'export',
    decision_url: 'export',
    decision_updated_by: 'export',
    knowledge_version: 'omit',
  },
  reactions: {
    id: 'export',
    message_id: 'export',
    user_id: 'export',
    emoji: 'export',
    created_at: 'export',
  },
  mentions: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    message_id: 'export',
    mentioned_user_id: 'export',
    created_at: 'export',
  },
  message_versions: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    message_id: 'export',
    content: 'export',
    replaced_at: 'export',
  },
  pinned_messages: {
    workspace_id: 'export',
    channel_id: 'export',
    message_id: 'export',
    pinned_by: 'export',
    pinned_at: 'export',
  },
  // The GitHub work a thread points at, as GitHub last said it (D-246): the channel's own record.
  github_links: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    root_id: 'export',
    repository_id: 'export',
    repository_full_name: 'export',
    kind: 'export',
    number: 'export',
    title: 'export',
    state: 'export',
    state_at: 'export',
    origin: 'export',
    created_by: 'export',
    created_at: 'export',
  },
  // A channel's links, the members' own content about it (D-218).
  channel_bookmarks: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    url: 'export',
    title: 'export',
    added_by: 'export',
    added_at: 'export',
  },
  attachments: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    message_id: 'export',
    uploader_id: 'export',
    file_name: 'export',
    mime_type: 'export',
    kind: 'export',
    size_bytes: 'export',
    width: 'export',
    height: 'export',
    created_at: 'export',
    // Where the object is kept on this server: the export names it by its id instead.
    storage_key: 'omit',
    thumbnail_key: 'omit',
  },
  incidents: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    severity: 'export',
    status: 'export',
    declared_by: 'export',
    declared_at: 'export',
    resolved_at: 'export',
    runbook_url: 'export',
    postmortem: 'export',
    postmortem_version: 'export',
  },
  incident_updates: {
    id: 'export',
    incident_id: 'export',
    actor_id: 'export',
    kind: 'export',
    from_value: 'export',
    to_value: 'export',
    at: 'export',
  },
  incident_responders: {
    incident_id: 'export',
    channel_id: 'export',
    user_id: 'export',
    added_by: 'export',
    added_at: 'export',
  },
  audit_log: {
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
  github_repo_feeds: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    repository_id: 'export',
    repository_full_name: 'export',
    events: 'export',
    created_by: 'export',
    created_at: 'export',
    last_delivery_at: 'export',
    last_failure_at: 'export',
    last_failure: 'export',
    // The webhook's secret, sealed: a credential never leaves (D-134 §4).
    secret_encrypted: 'omit',
  },
  workspace_invitations: {
    id: 'export',
    workspace_id: 'export',
    created_by: 'export',
    created_at: 'export',
    expires_at: 'export',
    revoked_at: 'export',
    // The link's secret, digested: it would still open nothing, and says nothing either.
    token_hash: 'omit',
  },
  users: {
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
};

/** Every other table, and why it is not in an export. Exhaustive: a new table must say. */
export const EXCLUDED: Readonly<Record<Exclude<keyof Database, ExportedTable>, string>> = {
  accounts: 'a provider’s account and a credential’s password hash: the person’s own (D-179)',
  verifications: 'short-lived sign-in tokens, credentials of the person’s own (D-179)',
  two_factors:
    'an authenticator app’s sealed key and the backup codes: a second credential, the person’s own (D-236)',
  rate_limits:
    'sign-in and invitation-mail counters by client address, address digest or id, nobody’s record (D-179)',
  sessions: 'a credential, the person’s own',
  push_subscriptions: 'a device’s keys, the person’s own',
  github_integrations: 'the sealed GitHub token: a credential never leaves',
  github_deliveries: 'an idempotency log of webhook deliveries, nobody’s record',
  incoming_webhooks:
    'a channel’s incoming webhooks: each the digest of the secret its address carries, a credential, never exported; what they posted is in `messages`, under the name each posted with (D-245)',
  github_app_installations:
    'which installation of the server’s GitHub App the workspace connected: a connection to a credential the server holds, as the token is (D-246)',
  github_user_authorizations:
    'a person’s sealed GitHub App tokens: credentials, the person’s own, never exported (D-246)',
  github_app_handshakes:
    'digests of the state of a trip to GitHub and back, and its sealed verifier, for ten minutes: credentials (D-246)',
  github_app_deliveries:
    'an idempotency log of the GitHub App’s deliveries, nobody’s record (D-246)',
  github_operations:
    'the bounded record of one attempt to make an issue — its request id, a digest of what was asked, never the words: an idempotency record, nobody’s (D-246 §4)',
  notifications: 'each person’s inbox, their own state',
  missed_mail_letters:
    'when each person was last emailed about what they missed, and the digest of the link that stops it: a credential, the person’s own (D-240)',
  saved_messages: 'each person’s saved items, their own state',
  saved_searches: 'each person’s named filters, their own state',
  thread_follows: 'which threads each person follows or let go, their own state',
  link_previews: 'a cache of other sites’ pages',
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

/** The migrator's own tables: not in the generated schema at all, and not anybody's record. */
export const MIGRATOR_TABLES: readonly string[] = ['kysely_migration', 'kysely_migration_lock'];

/**
 * What a person's export of their own data holds (D-241), decided the same way: a table or a column a
 * migration adds is a compile error here until somebody decides whether a person's own copy carries it.
 *
 * - **Everything about them goes**: their account's fields (none of which is a secret — the password's
 *   hash, the second step's key and the sessions' tokens live in other tables), their memberships and
 *   what they set on each — notification levels, stars, Deep Work, threads followed — what they wrote,
 *   reacted, saved, searched for and kept as a channel's link, and the files they sent.
 * - **Nothing of anybody else's**: no other person's row, words or name. A row of theirs names other
 *   things by id — a message they reacted to, a channel — and only the workspaces and channels their
 *   rows name are written, by id, name and kind, so the ids mean something.
 * - **What is the thread's or the team's, not theirs, stays**: who resolved it, who it was assigned to,
 *   the decision someone noted, its replies' count — and the realtime layer's bookkeeping.
 */
type Personal = 'export' | 'omit';

/** The tables a person's export writes, one NDJSON file each. */
export type PersonalTable =
  | 'users'
  | 'workspaces'
  | 'workspace_members'
  | 'channels'
  | 'channel_members'
  | 'messages'
  | 'reactions'
  | 'attachments'
  | 'saved_messages'
  | 'saved_searches'
  | 'thread_follows'
  | 'channel_bookmarks';

type PersonalColumns = {
  readonly [T in PersonalTable]: { readonly [C in keyof Database[T]]: Personal };
};

export const PERSONAL_COLUMNS: PersonalColumns = {
  // Their own row, every field: what the server holds about who they are and how they sign in.
  users: {
    id: 'export',
    username: 'export',
    display_name: 'export',
    avatar_url: 'export',
    email: 'export',
    email_verified: 'export',
    github_id: 'export',
    github_login: 'export',
    github_connected_at: 'export',
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
  // A workspace their rows name: enough to say which it was.
  workspaces: {
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
  workspace_members: {
    id: 'export',
    workspace_id: 'export',
    user_id: 'export',
    role: 'export',
    joined_at: 'export',
    deep_work_until: 'export',
    is_deep_work_active: 'export',
  },
  // A channel their rows name: which, in which workspace, and what kind. A direct conversation's key is
  // the other person's id.
  channels: {
    id: 'export',
    workspace_id: 'export',
    name: 'export',
    type: 'export',
    topic: 'omit',
    dm_key: 'omit',
    created_by: 'omit',
    created_at: 'omit',
    updated_at: 'omit',
    deleted_at: 'omit',
    last_message_at: 'omit',
    min_retention_days: 'omit',
    retain_forever: 'omit',
    state_version: 'omit',
  },
  channel_members: {
    id: 'export',
    channel_id: 'export',
    user_id: 'export',
    joined_at: 'export',
    last_read_message_id: 'export',
    notification_level: 'export',
    starred_at: 'export',
    // Counts the server keeps for the badge, and the realtime layer's ordering.
    unread_count: 'omit',
    unread_mention_count: 'omit',
    state_version: 'omit',
  },
  // What they wrote and has not been deleted: a deleted message's words are not offered back (D-9).
  messages: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    parent_id: 'export',
    sender_id: 'export',
    message_type: 'export',
    content: 'export',
    metadata: 'export',
    is_question: 'export',
    created_at: 'export',
    updated_at: 'export',
    edited_at: 'export',
    deleted_at: 'omit',
    // The thread's, and other people's acts on it.
    thread_reply_count: 'omit',
    thread_last_reply_at: 'omit',
    resolved_at: 'omit',
    resolved_by: 'omit',
    question_assignee_id: 'omit',
    accepted_answer_id: 'omit',
    decision_note: 'omit',
    decision_url: 'omit',
    decision_updated_by: 'omit',
    state_version: 'omit',
    changed_at: 'omit',
    knowledge_version: 'omit',
  },
  reactions: {
    id: 'export',
    message_id: 'export',
    user_id: 'export',
    emoji: 'export',
    created_at: 'export',
  },
  attachments: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    message_id: 'export',
    uploader_id: 'export',
    file_name: 'export',
    mime_type: 'export',
    kind: 'export',
    size_bytes: 'export',
    width: 'export',
    height: 'export',
    created_at: 'export',
    // Where the object is kept on this server: the export names it by its id instead.
    storage_key: 'omit',
    thumbnail_key: 'omit',
  },
  saved_messages: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    message_id: 'export',
    user_id: 'export',
    state: 'export',
    saved_at: 'export',
    updated_at: 'export',
  },
  saved_searches: {
    id: 'export',
    workspace_id: 'export',
    user_id: 'export',
    name: 'export',
    query: 'export',
    created_at: 'export',
  },
  thread_follows: {
    workspace_id: 'export',
    channel_id: 'export',
    message_id: 'export',
    user_id: 'export',
    following: 'export',
    updated_at: 'export',
  },
  channel_bookmarks: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    url: 'export',
    title: 'export',
    added_by: 'export',
    added_at: 'export',
  },
};

/** Every other table, and why a person's export leaves it out. Exhaustive: a new table must say. */
export const PERSONAL_EXCLUDED: Readonly<Record<Exclude<keyof Database, PersonalTable>, string>> = {
  accounts: 'a provider’s account and a password’s hash: a credential (GitHub’s id is on `users`)',
  verifications: 'short-lived sign-in tokens: credentials',
  two_factors: 'an authenticator’s sealed key and the backup codes: a credential (D-236)',
  sessions: 'a credential; where they are signed in is listed in Sessions & account (D-193)',
  push_subscriptions: 'a device’s keys: a credential of the browser’s',
  native_authorizations: 'digests of one-time codes: credentials (D-191)',
  invitation_passports: 'digests of a cookie or an address: credentials (D-179 §5)',
  admin_email_verification: 'the digest of a link that verifies an address: a credential',
  rate_limits: 'counters by client address or digest, nobody’s record',
  notifications:
    'pointers to other people’s messages that mentioned or answered them: the words are the others’',
  mentions: 'who another person’s message named: the message is the other person’s',
  message_versions:
    'the words an edit replaced: not offered back, as a deleted message’s words are not (D-9)',
  pinned_messages: 'a channel’s pins: the channel’s record, not theirs',
  incidents: 'a channel’s incident: the team’s record',
  incident_updates: 'an incident’s timeline: the team’s record',
  incident_responders: 'who responded to an incident: the team’s record',
  audit_log: 'a workspace’s trail: its owners’ record, not the person’s',
  server_audit_log: 'the server’s trail: the operator’s record',
  github_repo_feeds: 'a channel’s feed and its sealed secret: the workspace’s',
  github_integrations: 'the workspace’s sealed GitHub token: a credential',
  github_deliveries: 'an idempotency log of webhook deliveries, nobody’s record',
  github_app_installations: 'the workspace’s connection to the server’s GitHub App (D-246)',
  github_user_authorizations:
    'the person’s sealed GitHub App tokens: credentials, never exported (D-246)',
  github_app_handshakes:
    'digests and a sealed verifier of a trip to GitHub, ten minutes long: credentials',
  github_app_deliveries: 'an idempotency log of the GitHub App’s deliveries, nobody’s record',
  github_links:
    'the GitHub work a thread points at: the team’s record, in the workspace’s export (D-246)',
  github_operations: 'a bounded idempotency record of making an issue: nobody’s record (D-246 §4)',
  workspace_invitations: 'a workspace’s links and their digests: the workspace’s, and credentials',
  link_previews: 'a cache of other sites’ pages',
  job_runs: 'the scheduler’s own record',
  object_deletions: 'storage keys waiting to be deleted: keys never leave',
  workspace_exports: 'an owner’s export of a workspace: the workspace’s record',
  personal_exports:
    'the record of this very export and the ones before it: its archive is the export',
  server_settings: 'the operator’s settings for the whole server',
  setup_state: 'where the server’s setup stands: the server’s',
  missed_mail_letters:
    'when each letter about what they missed went, and its stop link’s digest: a credential (D-240)',
};
