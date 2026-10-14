/**
 * The entities as they cross the wire.
 *
 * These are **not** the database rows. A row carries things no client should
 * receive — an email address every workspace member could then read, a soft-delete
 * timestamp, a GitHub identifier — and `ARCHITECTURE.md` §10 already forbids
 * logging most of them. What a client gets is decided here, once.
 *
 * Authored as TypeBox schemas with the TypeScript types derived from them, so
 * one definition both validates at runtime and types at compile time
 * (`ARCHITECTURE.md` §2). Hand-written types beside the schemas would be two
 * definitions of every shape.
 *
 * **camelCase on the wire, snake_case in the database.** The service layer maps
 * between them. A plugin that rewrites every identifier automatically would make
 * the query builder and the hand-written SQL disagree, and D-20 chose to write
 * SQL and joins by hand.
 */
import { Type, type Static, type TObject, type TProperties } from '@sinclair/typebox';
// Side effect: registers the string formats these schemas use. Without it
// TypeBox rejects every value carrying a `format`, valid ones included.
import './formats';

/** UUID, and for `messages` specifically a UUIDv7 the client generated (D-8). */
export const Uuid = Type.String({ format: 'uuid' });

/** ISO 8601, UTC. Never used for ordering — ordering is keyset on the id (D-8). */
export const Timestamp = Type.String({ format: 'date-time' });

/**
 * A shape the client sends.
 *
 * Unknown properties are **refused**, not ignored. TypeBox does not set
 * `additionalProperties: false` and neither does the server framework, so a
 * request carrying a field nobody validates returns 200 and the field is
 * silently dropped — a client sending `roleOverride` would be told it worked.
 * Silently discarding input is the failure class this project refuses everywhere
 * else (`CONTRIBUTING.md` §6.4), and there is no third-party client whose extra
 * fields we owe tolerance to: there is one client and it ships with the server
 * (D-51).
 *
 * Responses deliberately do **not** use this. Adding a field to something we
 * produce must not break a client that has not been rebuilt yet. (D-57)
 */
export const FromClient = <T extends TProperties>(
  properties: T,
  /** What else the shape holds: `minProperties` for a change that must change something. */
  options: { readonly minProperties?: number } = {},
): TObject<T> => Type.Object(properties, { ...options, additionalProperties: false });

export const UserRole = Type.Union([
  Type.Literal('owner'),
  Type.Literal('admin'),
  Type.Literal('member'),
]);
export type UserRole = Static<typeof UserRole>;

export const ChannelType = Type.Union([
  Type.Literal('public'),
  Type.Literal('private'),
  Type.Literal('direct_message'),
]);
export type ChannelType = Static<typeof ChannelType>;

/**
 * What a member is told about in a channel (D-107): every message by somebody else, only what is
 * addressed to them (the default — quiet is the product), or nothing at all.
 */
export const NotificationLevel = Type.Union([
  Type.Literal('all'),
  Type.Literal('mentions'),
  Type.Literal('none'),
]);
export type NotificationLevel = Static<typeof NotificationLevel>;

/**
 * Another member, as anyone in the workspace may see them.
 *
 * No email address: it is the identity anchor (D-11) and broadcasting it to
 * every member of a workspace is a disclosure nobody asked for.
 */
export const User = Type.Object({
  id: Uuid,
  username: Type.String({ maxLength: 39 }),
  displayName: Type.String({ maxLength: 128 }),
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
});
export type User = Static<typeof User>;

/**
 * What an erased account is called (D-139 §5): `deleted-user-` and a short, unique tail. No live account
 * may take a name beginning so — a new one is given another — so the client can say "deleted user" in
 * the reader's language from the name alone, wherever a person is shown.
 */
export const ERASED_USERNAME_PREFIX = 'deleted-user-';
export const isErased = (user: { readonly username: string }): boolean =>
  user.username.toLowerCase().startsWith(ERASED_USERNAME_PREFIX);

/** How long a profile's title and status line may be (D-131). */
export const PROFILE_TITLE_MAX = 80;
export const PROFILE_STATUS_MAX = 100;

/**
 * What a person says about themselves beyond the name GitHub gives them (D-131): a title, the time
 * zone their day is in (an IANA name), and a short status line. Each null until they set it.
 */
export const Profile = Type.Object({
  title: Type.Union([Type.String({ minLength: 1, maxLength: PROFILE_TITLE_MAX }), Type.Null()]),
  timeZone: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  status: Type.Union([Type.String({ minLength: 1, maxLength: PROFILE_STATUS_MAX }), Type.Null()]),
});
export type Profile = Static<typeof Profile>;

/** Yourself. The only shape that carries the email, and only ever to its owner. */
export const CurrentUser = Type.Composite([
  User,
  Type.Object({ email: Type.String({ format: 'email' }) }),
]);
export type CurrentUser = Static<typeof CurrentUser>;

export const Workspace = Type.Object({
  id: Uuid,
  name: Type.String({ maxLength: 64 }),
  slug: Type.String({ maxLength: 64 }),
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
});
export type Workspace = Static<typeof Workspace>;

/** Your membership of a workspace. Ownership is a role, never a column on the workspace (D-22). */
export const Membership = Type.Object({
  workspace: Workspace,
  role: UserRole,
  joinedAt: Timestamp,
  /**
   * Until when the caller is in Deep Work here (D-15, D-108), or null when they are not. It ends by
   * itself at this instant: the server stops counting it then, and so does the client.
   */
  deepWorkUntil: Type.Union([Timestamp, Type.Null()]),
});
export type Membership = Static<typeof Membership>;

/**
 * A person's read position in one channel, and what is waiting beyond it
 * (`SCHEMA.md` §5.2). Maintained on write (D-13, D-35), never counted on read.
 *
 * `unreadMentionCount` is what needs *you*: an `@username` mention, any message in a
 * direct message, and a reply in a thread you started or answered (D-29). It never
 * exceeds `unreadCount` (I-6) — a message that needs you is, first, one you have not
 * read.
 */
export const ChannelState = Type.Object({
  lastReadMessageId: Type.Union([Uuid, Type.Null()]),
  unreadCount: Type.Integer({ minimum: 0 }),
  unreadMentionCount: Type.Integer({ minimum: 0 }),
});
export type ChannelState = Static<typeof ChannelState>;

/** How bad an incident is (D-137): SEV1 is the worst. */
export const IncidentSeverity = Type.Union([
  Type.Literal(1),
  Type.Literal(2),
  Type.Literal(3),
  Type.Literal(4),
]);
export type IncidentSeverity = Static<typeof IncidentSeverity>;

/** Where an open incident is (D-137): either, either way round. */
export const OpenIncidentStatus = Type.Union([
  Type.Literal('investigating'),
  Type.Literal('mitigating'),
]);
export type OpenIncidentStatus = Static<typeof OpenIncidentStatus>;

/** Where an incident is (D-137): open, or resolved once and for good. */
export const IncidentStatus = Type.Union([OpenIncidentStatus, Type.Literal('resolved')]);
export type IncidentStatus = Static<typeof IncidentStatus>;

/** A channel's open incident, as its list shows it: enough for the sidebar's mark (D-137). */
export const ChannelIncident = Type.Object({
  severity: IncidentSeverity,
  status: OpenIncidentStatus,
});
export type ChannelIncident = Static<typeof ChannelIncident>;

export const Channel = Type.Object({
  id: Uuid,
  workspaceId: Uuid,
  /** Null for a direct message, which is identified by its members (D-6). */
  name: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  topic: Type.Union([Type.String(), Type.Null()]),
  type: ChannelType,
  /** Denormalised so the sidebar can order channels without touching `messages`. */
  lastMessageAt: Type.Union([Timestamp, Type.Null()]),
  /**
   * What *this caller* has read here — it differs per person, which is why it is
   * a field of the response and not of the channel. Null when the caller can see
   * the channel but has not joined it (a public channel they could join).
   */
  state: Type.Union([ChannelState, Type.Null()]),
  /** The caller's level here (D-107); null when they are not a member, and so are told nothing. */
  notificationLevel: Type.Union([NotificationLevel, Type.Null()]),
  /** Whether the caller keeps it among their starred (D-132); never for somebody not in it. */
  starred: Type.Boolean(),
  /**
   * The other person in a direct message between two (the caller themselves, for a note to
   * self). Null for a group conversation and for every other kind, which has a name (D-6, D-127).
   */
  peer: Type.Union([User, Type.Null()]),
  /**
   * The people of a direct message other than the caller, in the order of its key: one for a
   * conversation of two, two to nine for a group (D-127), the caller alone for a note to self.
   * Empty for a channel.
   */
  peers: Type.Array(User, { maxItems: 9 }),
  /** Its open incident (D-137); null when none is open, and always for a direct message. */
  incident: Type.Union([ChannelIncident, Type.Null()]),
});
export type Channel = Static<typeof Channel>;

/**
 * The longest message, in UTF-16 code units — what `String.length` counts.
 *
 * Sixteen thousand is roughly four hundred lines of stack trace, which `PRD.md`
 * names as something this product's users paste. It also bounds what the trigram
 * index has to digest per row. And it fits the socket's frame cap with room to
 * spare at the format's worst case of three bytes a unit — proven by a test, not
 * asserted here. The database enforces the same number (D-67).
 */
export const MESSAGE_CONTENT_MAX = 16_000;

/** What a client may send as a message's text. */
export const MessageContent = Type.String({
  minLength: 1,
  maxLength: MESSAGE_CONTENT_MAX,
  format: 'message-content',
});

/**
 * What a send may carry as its words: empty only beside an attachment (D-109 §7), which the service
 * says — as a refusal of `content` by name, which a union of two shapes could not. An edit still needs
 * words (`MessageContent`).
 */
export const SendContent = Type.String({
  maxLength: MESSAGE_CONTENT_MAX,
  format: 'message-content',
});

/**
 * The most GitHub links one message records for unfurling (D-101). Each becomes a
 * request to GitHub when it is unfurled (#66), so a sixteen-thousand-character body
 * cannot be a few hundred of them. The rest stay ordinary links.
 */
export const GITHUB_LINKS_PER_MESSAGE_MAX = 5;

/**
 * A GitHub pull request or issue, as the message's metadata records it and the unfurl endpoint
 * takes it: github.com, an owner, a repository, the kind and the number — nothing else, so what is
 * fetched is built from these parts and never from an address a person wrote (D-101).
 */
export const GitHubLink = Type.String({
  // GitHub's own shapes, as the message parser reads them (`@purlay/markdown`): an owner of 1–39,
  // a repository of 1–100 that is not `.` or `..` — which would step out of it once a URL is resolved
  // — and a number of at most ten digits.
  pattern:
    '^https://github\\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38})/(?!\\.\\.?/)([A-Za-z0-9._-]{1,100})/(pull|issues)/([0-9]{1,10})$',
});

/**
 * A repository as GitHub names it: an owner of up to 39 letters, digits and hyphens, not starting with
 * a hyphen; a name of up to 100 letters, digits, `.`, `_` and `-`, never `.` or `..`. Lowered, it is
 * exactly what `github_repo_feeds_repository_shape` holds (bound by `ingress/http/feeds.integration.test.ts`).
 */
export const GITHUB_REPOSITORY_PATTERN =
  '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/(?!\\.\\.?$)[A-Za-z0-9._-]{1,100}$';

/** How long a title, a release's name or a commit's first line is kept; longer is cut, with `…`. */
export const GITHUB_EVENT_TEXT_MAX = 256;

/** How many of a push's commits its message lists; the rest are behind the comparison. */
export const PUSH_COMMITS_SHOWN_MAX = 5;

/** How many commits GitHub lists in a push's delivery, at most. */
export const PUSH_COMMITS_LISTED_MAX = 2048;

const GitHubRepositoryName = Type.String({ pattern: GITHUB_REPOSITORY_PATTERN });
/**
 * A person's or an app's login: `octocat`, `dependabot[bot]`, and an enterprise's managed user,
 * `handle_shortcode`.
 */
export const GITHUB_LOGIN_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(\\[bot\\])?$';
const GitHubLogin = Type.String({ pattern: GITHUB_LOGIN_PATTERN });
const CommitSha = Type.String({ pattern: '^[0-9a-f]{40}$' });
const GitHubText = Type.String({ maxLength: GITHUB_EVENT_TEXT_MAX });
const GitHubNumber = Type.Integer({ minimum: 1, maximum: 9_999_999_999 });
/** A branch's or a tag's name: what git allows, bounded. */
export const GIT_REF_NAME_MAX = 1024;
const GitRefName = Type.String({ minLength: 1, maxLength: GIT_REF_NAME_MAX });

/** An object with no field the contract does not name: what is stored is what is shown, nothing more. */
const Closed = <T extends TProperties>(properties: T): TObject<T> =>
  Type.Object(properties, { additionalProperties: false });

/**
 * What happened in a repository, as its feed posted it (D-134 §6): parts only, every one bounded,
 * so every link the client draws is built from them — never an address taken from GitHub's payload
 * (D-101). `kind` is GitHub's event; within it, what the client says.
 */
export const GitHubEvent = Type.Union([
  Closed({
    kind: Type.Literal('push'),
    repository: GitHubRepositoryName,
    actor: GitHubLogin,
    ref: Closed({
      type: Type.Union([Type.Literal('branch'), Type.Literal('tag')]),
      name: GitRefName,
    }),
    /** A push to what was there, the ref made, the ref deleted, or history rewritten. */
    change: Type.Union([
      Type.Literal('pushed'),
      Type.Literal('created'),
      Type.Literal('deleted'),
      Type.Literal('forced'),
    ]),
    before: CommitSha,
    after: CommitSha,
    /** The newest first, at most `PUSH_COMMITS_SHOWN_MAX`. */
    commits: Type.Array(Closed({ sha: CommitSha, title: GitHubText }), {
      maxItems: PUSH_COMMITS_SHOWN_MAX,
    }),
    /** As many as GitHub listed, which is at most 2,048: a bigger push says 2,048. */
    commitCount: Type.Integer({ minimum: 0, maximum: PUSH_COMMITS_LISTED_MAX }),
  }),
  Closed({
    kind: Type.Literal('pull_request'),
    repository: GitHubRepositoryName,
    actor: GitHubLogin,
    /** `merged` is GitHub's `closed` with the pull request merged. */
    action: Type.Union([
      Type.Literal('opened'),
      Type.Literal('closed'),
      Type.Literal('merged'),
      Type.Literal('reopened'),
      Type.Literal('ready_for_review'),
    ]),
    number: GitHubNumber,
    title: GitHubText,
  }),
  Closed({
    kind: Type.Literal('issues'),
    repository: GitHubRepositoryName,
    actor: GitHubLogin,
    action: Type.Union([Type.Literal('opened'), Type.Literal('closed'), Type.Literal('reopened')]),
    number: GitHubNumber,
    title: GitHubText,
  }),
  Closed({
    kind: Type.Literal('release'),
    repository: GitHubRepositoryName,
    actor: GitHubLogin,
    tag: GitRefName,
    name: GitHubText,
    /** A pre-release: said as one, so a candidate is not read as what shipped. */
    prerelease: Type.Boolean(),
  }),
]);
export type GitHubEvent = Static<typeof GitHubEvent>;

/**
 * What the parser records about a text message when it is written: hints for the
 * renderer, derived once (`SCHEMA.md` §6.4, `ARCHITECTURE.md` §8.1). Not on the wire
 * yet: nothing reads it until the code block badge (#44) and unfurling (#66) do.
 */
export const TextMetadata = Type.Object(
  {
    /** Languages of fenced code blocks, in order; an unlabelled fence is `''`. */
    codeLanguages: Type.Optional(Type.Array(Type.String())),
    /** GitHub pull request and issue addresses, unique, in the order they appear. */
    githubLinks: Type.Optional(
      Type.Array(GitHubLink, { maxItems: GITHUB_LINKS_PER_MESSAGE_MAX, uniqueItems: true }),
    ),
    /** Present, and true, when the body is a single fenced block, which renders full-bleed; absent otherwise. */
    isCodeOnly: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
export type TextMetadata = Static<typeof TextMetadata>;

/**
 * One emoji and the people who used it. The people, not a count: every client
 * needs to know whether *it* is among them, and a frame broadcast to a channel
 * cannot say that per recipient. The count is the length.
 */
export const Reaction = Type.Object({
  emoji: Type.String({ minLength: 1, maxLength: 32, format: 'emoji' }),
  userIds: Type.Array(Uuid, { minItems: 1 }),
});
export type Reaction = Static<typeof Reaction>;

/**
 * What a root message knows about its replies, so a feed of fifty roots is not
 * fifty more queries (`SCHEMA.md` §6.1). `resolvedAt` and `resolvedBy` are both set
 * or both null — the database's `resolution_is_complete` — and only a root with at
 * least one reply can be resolved (I-8).
 */
export const ThreadSummary = Type.Object({
  replyCount: Type.Integer({ minimum: 0 }),
  lastReplyAt: Type.Union([Timestamp, Type.Null()]),
  resolvedAt: Type.Union([Timestamp, Type.Null()]),
  resolvedBy: Type.Union([User, Type.Null()]),
});
export type ThreadSummary = Static<typeof ThreadSummary>;

/**
 * The bounds of an attachment (D-16, D-109 §2). The database holds the same numbers as CHECKs
 * (`attachment_size_limit`, `attachment_dimensions`, migration 0018), and a test inserts at each
 * bound and one past it, so the two cannot drift.
 */
export const ATTACHMENT_BYTES_MAX = 26_214_400;
export const ATTACHMENT_SIDE_MAX = 16_384;
export const ATTACHMENT_PIXELS_MAX = 40_000_000;

/** What a file is to the product: an image Purlay re-encoded and can draw, or anything else (D-109 §1). */
export const AttachmentKind = Type.Union([
  Type.Literal('image'),
  Type.Literal('video'),
  Type.Literal('audio'),
  Type.Literal('file'),
]);
export type AttachmentKind = Static<typeof AttachmentKind>;

/** An uploaded file, as its uploader and the readers of its message see it (D-109). */
export const Attachment = Type.Object({
  id: Uuid,
  fileName: Type.String({ minLength: 1, maxLength: 255 }),
  mimeType: Type.String({ minLength: 1, maxLength: 128 }),
  sizeBytes: Type.Integer({ minimum: 1, maximum: ATTACHMENT_BYTES_MAX }),
  kind: AttachmentKind,
  /** Present for an image, so the client reserves its space before it loads. */
  width: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  height: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
});
export type Attachment = Static<typeof Attachment>;

/** The most attachments one message carries (D-109 §7). */
export const ATTACHMENTS_PER_MESSAGE_MAX = 10;

/** The uploads a send carries: the sender's own, unattached, each once (D-109 §3, §7). */
export const AttachmentIds = Type.Array(Uuid, {
  minItems: 1,
  maxItems: ATTACHMENTS_PER_MESSAGE_MAX,
  uniqueItems: true,
});

export const Message = Type.Object({
  /** A UUIDv7 the client generated. It is also the pagination cursor. (D-8) */
  id: Uuid,
  channelId: Uuid,
  /**
   * Who wrote it; null for a message nobody wrote — a repository's event (D-134 §6), which carries
   * `githubEvent` instead. At most one of the two is set — both are null for a removed event: the
   * database holds it (`messages_sender_by_type`) and the one reader builds both from the same row.
   */
  sender: Type.Union([User, Type.Null()]),
  /** What happened in a repository, for a message its feed posted; null for a person's, and a tombstone's. */
  githubEvent: Type.Union([GitHubEvent, Type.Null()]),
  content: Type.String(),
  /** Set when the message has been edited; the content is the current version. */
  editedAt: Type.Union([Timestamp, Type.Null()]),
  /**
   * A deleted message is tombstoned rather than erased, so it still occupies its
   * place in the thread it belongs to (D-9). `content` is the tombstone.
   */
  deletedAt: Type.Union([Timestamp, Type.Null()]),
  createdAt: Timestamp,
  /** The root this replies to; null for a root. Threads are two levels deep (I-1). */
  parentId: Type.Union([Uuid, Type.Null()]),
  /** A root's replies, in summary; null for a reply, which has none of its own. */
  thread: Type.Union([ThreadSummary, Type.Null()]),
  reactions: Type.Array(Reaction),
  /**
   * The people this message names with `@username`, resolved once at write time
   * (D-12) so no client re-parses a body to find out who was addressed.
   */
  mentions: Type.Array(Uuid),
  /** What it carries, in upload order; none on a tombstone (D-109 §6). */
  attachments: Type.Array(Attachment, { maxItems: ATTACHMENTS_PER_MESSAGE_MAX }),
});
export type Message = Static<typeof Message>;
