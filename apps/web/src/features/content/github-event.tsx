/**
 * What a repository's feed posted, drawn (#79, D-134 §6): a sentence in the reader's language — who
 * did what — and the things it names, each a link to GitHub. Every address is built from the event's
 * parts (D-101): the repository, a number, a sha, a branch's or a tag's name, each segment encoded —
 * never one taken from GitHub's payload.
 */
import { excerptOf } from '@purlay/markdown';
import type { GitHubEvent, Message } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import type { Translate } from '../../i18n/types';
import { cn } from '../../ui/cn';

const GITHUB = 'https://github.com';

/** A ref's name as a path: each segment encoded, the slashes between them kept. */
const refPath = (name: string): string => name.split('/').map(encodeURIComponent).join('/');

const repositoryUrl = (event: GitHubEvent): string => `${GITHUB}/${event.repository}`;

const linkOf = (event: GitHubEvent): string => {
  const repository = repositoryUrl(event);
  switch (event.kind) {
    case 'push':
      // A comparison only when there is something on both sides of it.
      return event.change === 'pushed' || event.change === 'forced'
        ? `${repository}/compare/${event.before.slice(0, 12)}...${event.after.slice(0, 12)}`
        : `${repository}/tree/${refPath(event.ref.name)}`;
    case 'pull_request':
      return `${repository}/pull/${String(event.number)}`;
    case 'issues':
      return `${repository}/issues/${String(event.number)}`;
    case 'release':
      return `${repository}/releases/tag/${refPath(event.tag)}`;
  }
};

/** Who did what, as a sentence in the reader's language. */
export const eventSentence = (event: GitHubEvent, t: Translate): string => {
  const actor = event.actor;
  switch (event.kind) {
    case 'push': {
      const ref = event.ref.name;
      switch (event.change) {
        case 'pushed':
          return t('github.push.pushed', { actor, ref, count: event.commitCount });
        case 'forced':
          return t('github.push.forced', { actor, ref });
        case 'created':
          return event.ref.type === 'branch'
            ? t('github.push.createdBranch', { actor, ref })
            : t('github.push.createdTag', { actor, ref });
        case 'deleted':
          return event.ref.type === 'branch'
            ? t('github.push.deletedBranch', { actor, ref })
            : t('github.push.deletedTag', { actor, ref });
      }
      break;
    }
    case 'pull_request':
      return t(`github.pullRequest.${event.action}`, { actor, number: event.number });
    case 'issues':
      return t(`github.issue.${event.action}`, { actor, number: event.number });
    case 'release':
      return t(event.prerelease ? 'github.release.prereleased' : 'github.release.published', {
        actor,
        name: event.name === '' ? event.tag : event.name,
      });
  }
};

/** What a list shows of a message: its words, or for an event, its sentence. */
export const useMessageText = (): ((
  message: Pick<Message, 'content' | 'githubEvent'>,
) => string) => {
  const { t } = useI18n();
  // The words a reader sees, not the marks typed to make them (#651).
  return (message) =>
    message.githubEvent === null
      ? excerptOf(message.content)
      : eventSentence(message.githubEvent, t);
};

const link = 'text-ink hover:underline';

export const GitHubEventCard = ({ event }: { readonly event: GitHubEvent }): React.JSX.Element => {
  const { t } = useI18n();
  const title =
    event.kind === 'pull_request' || event.kind === 'issues'
      ? event.title
      : event.kind === 'release'
        ? event.name === ''
          ? event.tag
          : event.name
        : null;
  const shown = event.kind === 'push' ? event.commits : [];
  const more = event.kind === 'push' ? event.commitCount - event.commits.length : 0;
  return (
    <div data-github-event={event.kind} className="flex flex-col gap-1">
      <p>
        <a href={linkOf(event)} target="_blank" rel="noopener noreferrer" className={link}>
          {eventSentence(event, t)}
        </a>
      </p>
      {title !== null && <p className="font-medium">{title}</p>}
      {shown.length > 0 && (
        <ul className="flex flex-col gap-1 text-label">
          {shown.map((commit) => (
            <li key={commit.sha} className="flex min-w-0 gap-2">
              <a
                href={`${repositoryUrl(event)}/commit/${commit.sha}`}
                target="_blank"
                rel="noopener noreferrer"
                className={cn('shrink-0 font-mono', link)}
              >
                {commit.sha.slice(0, 7)}
              </a>
              <span className="min-w-0 truncate">{commit.title}</span>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && (
        <p className="text-caption text-ink-muted">{t('github.push.more', { count: more })}</p>
      )}
      <a
        href={repositoryUrl(event)}
        target="_blank"
        rel="noopener noreferrer"
        className={cn('font-mono text-caption text-ink-muted', link)}
      >
        {event.repository}
      </a>
    </div>
  );
};
