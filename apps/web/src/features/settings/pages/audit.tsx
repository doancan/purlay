/**
 * The audit trail (D-26), read in the app by an owner or an admin: who did which administrative thing
 * to whom, newest first, a page at a time — so "who removed that member" has an answer without `curl`.
 *
 * Each action the API records (`AUDIT_ACTIONS`) has a sentence, chosen by an exhaustive `switch`, so
 * an action added there without a sentence here does not compile. The
 * wire carries a string, though: an action newer than this client is said by its name, never dropped.
 * People and channels are named from the lists the app already holds; somebody erased, or a channel
 * gone, is said as such. Nothing anybody wrote is here — the trail never had it (D-26).
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { AUDIT_ACTIONS, type AuditAction, type AuditEntry, type UserRole } from '@purlay/types';
import { useApi } from '../../../data/api-provider';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useChannels, useMembers } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { Icon } from '../../../components/icon';
import { Avatar } from '../../../ui/avatar';
import { Button } from '../../../ui/button';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useWorkspace } from '../../shell/workspace';
import { SettingsCard, SettingsPage } from '../page';

const known = (action: string): AuditAction | undefined => AUDIT_ACTIONS.find((a) => a === action);
const roleOf = (word: string | undefined): UserRole | undefined =>
  word === 'member' || word === 'admin' || word === 'owner' ? word : undefined;

export const AuditPage = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const members = useMembers(workspace.id);
  const channels = useChannels(workspace.id);
  const trail = useInfiniteQuery({
    queryKey: keys.audit(workspace.id),
    queryFn: async ({ pageParam, signal }) => await api.audit(workspace.id, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const person = (userId: string | undefined): string =>
    members.data?.find((m) => m.user.id === userId)?.user.displayName ?? t('audit.someoneElse');
  /** A window on the trail: `forever`, or its days — in the reader's words (D-41). */
  const kept = (word: string | undefined): string =>
    word === 'forever' ? t('retention.forever') : t('retention.days', { days: word ?? '' });
  const role = (word: string | undefined): string => {
    switch (roleOf(word)) {
      case 'member':
        return t('members.role.member');
      case 'admin':
        return t('members.role.admin');
      case 'owner':
        return t('members.role.owner');
      case undefined:
        return word ?? '';
    }
  };

  const sentence = (entry: AuditEntry): string => {
    const actor = entry.actor?.displayName ?? t('audit.someone');
    const action = known(entry.action);
    switch (action) {
      case 'member.role_changed':
        return t('audit.action.member.role_changed', {
          actor,
          target: person(entry.targetId ?? undefined),
          from: role(entry.metadata['from']),
          to: role(entry.metadata['to']),
        });
      case 'member.removed':
        return t('audit.action.member.removed', {
          actor,
          target: person(entry.targetId ?? undefined),
        });
      case 'member.left':
        return t('audit.action.member.left', { actor });
      case 'member.joined':
        return t('audit.action.member.joined', { actor });
      case 'channel.created': {
        const channel = channels.data?.find((c) => c.id === entry.targetId);
        return t('audit.action.channel.created', {
          actor,
          channel: channel?.name == null ? t('audit.goneChannel') : `#${channel.name}`,
        });
      }
      case 'channel.renamed':
        return t('audit.action.channel.renamed', {
          actor,
          from: `#${entry.metadata['from'] ?? ''}`,
          to: `#${entry.metadata['to'] ?? ''}`,
        });
      case 'channel.archived':
        return t('audit.action.channel.archived', {
          actor,
          channel: `#${entry.metadata['name'] ?? ''}`,
        });
      case 'integration.token_set':
        return t('audit.action.integration.token_set', { actor });
      case 'integration.token_removed':
        return t('audit.action.integration.token_removed', { actor });
      // Named only from the channels this viewer can see: a private one they are not in, or an entry
      // from before the channel was recorded, stays "a channel" (#691).
      case 'integration.feed_created':
      case 'integration.feed_removed': {
        const repository = entry.metadata['repository'] ?? '';
        const name = channels.data?.find((c) => c.id === entry.metadata['channelId'])?.name;
        const removed = entry.action === 'integration.feed_removed';
        if (name == null) {
          return removed
            ? t('audit.action.integration.feed_removed', { actor, repository })
            : t('audit.action.integration.feed_created', { actor, repository });
        }
        const channel = `#${name}`;
        return removed
          ? t('audit.action.integration.feed_removed_from', { actor, repository, channel })
          : t('audit.action.integration.feed_created_in', { actor, repository, channel });
      }
      case 'invitation.created':
        return t('audit.action.invitation.created', { actor });
      case 'invitation.revoked':
        return t('audit.action.invitation.revoked', { actor });
      case 'message.removed_by_moderator':
        return t('audit.action.message.removed_by_moderator', {
          actor,
          author: person(entry.metadata['authorId']),
        });
      case 'workspace.renamed':
        return t('audit.action.workspace.renamed', {
          actor,
          from: entry.metadata['from'] ?? '',
          to: entry.metadata['to'] ?? '',
        });
      case 'retention.changed':
        return t('audit.action.retention.changed', {
          actor,
          from: kept(entry.metadata['from']),
          to: kept(entry.metadata['to']),
        });
      // The person is gone, so the sentence names nobody (D-139 §5).
      case 'account.erased':
        return t('audit.action.account.erased');
      // An owner's, or the server operator's when nobody in the workspace asked (D-140).
      case 'workspace.export_requested':
        return t('audit.action.workspace.export_requested', { actor });
      case 'workspace.exported':
        return t('audit.action.workspace.exported', {
          actor: entry.actor === null ? t('audit.operator') : actor,
          messages: entry.metadata['messages'] ?? '0',
        });
      // The operator's act, on request (D-139 §7): what went, and nobody named.
      case 'content.erased':
        return t('audit.action.content.erased', {
          messages: entry.metadata['messages'] ?? '0',
          files: entry.metadata['files'] ?? '0',
        });
      // Nobody did it: the nightly purge, which names no actor (D-139 §3).
      case 'retention.purged':
        return t('audit.action.retention.purged', {
          days: entry.metadata['days'] ?? '',
          messages: entry.metadata['messages'] ?? '0',
          files: entry.metadata['files'] ?? '0',
        });
      case undefined:
        return t('audit.unknown', { actor, action: entry.action });
    }
  };

  const entries = (trail.data?.pages ?? []).flatMap((page) => page.data);

  return (
    <SettingsPage title={t('settings.audit.title')} description={t('audit.description')}>
      <SettingsCard>
        {trail.isError && trail.data === undefined ? (
          <div className="flex items-center gap-3 px-6 py-5 max-narrow:px-4">
            <p className="min-w-0 flex-1 text-body text-ink-muted">{describe(trail.error)}</p>
            <Button
              onClick={() => {
                void trail.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : trail.data === undefined ? (
          <LoadingStatus label={t('common.loading')} className="flex flex-col gap-3 px-6 py-5">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </LoadingStatus>
        ) : entries.length === 0 ? (
          <p className="px-6 py-5 text-body text-ink-muted max-narrow:px-4">{t('audit.empty')}</p>
        ) : (
          <ol aria-label={t('settings.audit.title')} className="flex flex-col">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-3 not-first:border-t-hairline border-border-subtle px-6 py-3 max-narrow:items-start max-narrow:px-4"
              >
                {/* Who acted, at a glance; nobody (the nightly purge, an erased account) is the system. */}
                {entry.actor === null ? (
                  <span className="inline-flex size-avatar shrink-0 items-center justify-center rounded-lg bg-surface-200 text-ink-muted">
                    <Icon name="history" size="sm" />
                  </span>
                ) : (
                  <Avatar
                    name={entry.actor.displayName}
                    username={entry.actor.username}
                    size="md"
                  />
                )}
                <span className="flex min-w-0 flex-1 items-baseline gap-6 max-narrow:flex-col max-narrow:gap-1">
                  <span data-audit-line="" className="min-w-0 flex-1 text-body text-ink">
                    {sentence(entry)}
                  </span>
                  <time
                    dateTime={entry.createdAt}
                    className="shrink-0 font-mono text-caption text-ink-muted"
                  >
                    {format.absolute(entry.createdAt)}
                  </time>
                </span>
              </li>
            ))}
          </ol>
        )}
        {trail.hasNextPage && (
          <footer className="flex justify-center border-t-hairline border-border-subtle px-6 py-3">
            <Button
              variant="ghost"
              busy={trail.isFetchingNextPage}
              onClick={() => {
                void trail.fetchNextPage();
              }}
            >
              {t('audit.older')}
            </Button>
          </footer>
        )}
      </SettingsCard>
    </SettingsPage>
  );
};
