/**
 * What GitHub sends, read into what a feed posts (#79, D-134 §6): a pure function of the event's name
 * and its parsed body. Only the parts the contract names are taken, each cut to its bound — a commit's
 * first line, a title — and the result is checked against `GitHubEvent` here, once, so what is stored
 * is what every reader can say (`messages_event_known` holds the kind as well).
 *
 * GitHub's bodies are open — it adds fields — so they are read with open schemas; what they must hold
 * is checked, and nothing else is kept.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  GITHUB_EVENT_TEXT_MAX,
  GitHubEvent,
  PUSH_COMMITS_SHOWN_MAX,
  type GitHubFeedEventName,
} from '@purlay/types';

const Sha = Type.String({ pattern: '^[0-9a-f]{40}$' });

/** What every delivery a feed takes names: the repository, by its number and its name, and who. */
const Envelope = Type.Object({
  repository: Type.Object({
    id: Type.Integer({ minimum: 1 }),
    full_name: Type.String({ minLength: 3, maxLength: 140 }),
  }),
  sender: Type.Object({ login: Type.String({ minLength: 1, maxLength: 64 }) }),
});
type Envelope = Static<typeof Envelope>;

const PushBody = Type.Composite([
  Envelope,
  Type.Object({
    ref: Type.String({ minLength: 1, maxLength: 300 }),
    before: Sha,
    after: Sha,
    created: Type.Boolean(),
    deleted: Type.Boolean(),
    forced: Type.Boolean(),
    commits: Type.Array(Type.Object({ id: Sha, message: Type.String() })),
  }),
]);

/** What a delivery is, read: an event to post, one this feed does not post, or a body it cannot read. */
export type Reading =
  | { readonly kind: 'event'; readonly event: GitHubEvent; readonly envelope: Envelope }
  | { readonly kind: 'ignored'; readonly envelope: Envelope | null }
  | { readonly kind: 'invalid' };

/** A line of text cut to the contract's bound, with `…` where it was cut. */
const bounded = (text: string): string => {
  const line = text.split('\n')[0]?.trim() ?? '';
  const characters = Array.from(line);
  return characters.length <= GITHUB_EVENT_TEXT_MAX
    ? line
    : `${characters.slice(0, GITHUB_EVENT_TEXT_MAX - 1).join('')}…`;
};

const BRANCH = 'refs/heads/';
const TAG = 'refs/tags/';

const pushOf = (body: Static<typeof PushBody>): GitHubEvent | null => {
  const ref = body.ref.startsWith(BRANCH)
    ? { type: 'branch' as const, name: body.ref.slice(BRANCH.length) }
    : body.ref.startsWith(TAG)
      ? { type: 'tag' as const, name: body.ref.slice(TAG.length) }
      : null;
  // A note, a pull request's head, anything not a branch or a tag: not what a channel hears about.
  if (ref === null) return null;
  return {
    kind: 'push',
    repository: body.repository.full_name,
    actor: body.sender.login,
    ref,
    change: body.deleted ? 'deleted' : body.created ? 'created' : body.forced ? 'forced' : 'pushed',
    before: body.before,
    after: body.after,
    // GitHub lists the oldest first, at most twenty: the newest are what a reader wants.
    commits: body.commits
      .slice(-PUSH_COMMITS_SHOWN_MAX)
      .reverse()
      .map((commit) => ({ sha: commit.id, title: bounded(commit.message) })),
    commitCount: Math.min(body.commits.length, 20),
  };
};

/**
 * The event `name` (`X-GitHub-Event`) and its body, for a feed that posts `wanted`. A body that does
 * not have what its event must is `invalid`; one this feed does not post, or an event GitHub sends
 * that no feed posts, is `ignored` — never an error, since GitHub sends what its hook was set to.
 */
export const readDelivery = (
  name: string,
  body: unknown,
  wanted: readonly GitHubFeedEventName[],
): Reading => {
  if (!Value.Check(Envelope, body)) return { kind: 'invalid' };
  const envelope: Envelope = {
    repository: { id: body.repository.id, full_name: body.repository.full_name },
    sender: { login: body.sender.login },
  };
  if (name !== 'push' || !wanted.includes('push')) return { kind: 'ignored', envelope };
  if (!Value.Check(PushBody, body)) return { kind: 'invalid' };
  const event = pushOf(body);
  if (event === null) return { kind: 'ignored', envelope };
  return Value.Check(GitHubEvent, event) ? { kind: 'event', event, envelope } : { kind: 'invalid' };
};

/** What search finds for an event: an English line, never shown (D-134 §6). */
export const summaryOf = (event: GitHubEvent): string => {
  switch (event.kind) {
    case 'push':
      return [
        `${event.actor} ${event.change} ${event.ref.type} ${event.ref.name} in ${event.repository}`,
        ...event.commits.map((commit) => commit.title),
      ].join('\n');
    case 'pull_request':
      return `${event.actor} ${event.action} pull request #${String(event.number)} in ${event.repository}: ${event.title}`;
    case 'issues':
      return `${event.actor} ${event.action} issue #${String(event.number)} in ${event.repository}: ${event.title}`;
    case 'release':
      return `${event.actor} published release ${event.tag} in ${event.repository}: ${event.name}`;
  }
};
