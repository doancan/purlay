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
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useChannels, useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { useWorkspace } from '../shell/workspace';

const known = (action: string): AuditAction | undefined => AUDIT_ACTIONS.find((a) => a === action);
const roleOf = (word: string | undefined): UserRole | undefined =>
  word === 'member' || word === 'admin' || word === 'owner' ? word : undefined;

export const AuditDialog = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
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
    enabled: open,
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
      case 'integration.feed_created':
        return t('audit.action.integration.feed_created', {
          actor,
          repository: entry.metadata['repository'] ?? '',
        });
      case 'integration.feed_removed':
        return t('audit.action.integration.feed_removed', {
          actor,
          repository: entry.metadata['repository'] ?? '',
        });
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
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('audit.title', { workspace: workspace.name })}
      description={t('audit.description')}
      closeLabel={t('common.close')}
    >
      {trail.isError && trail.data === undefined ? (
        <div className="flex items-center gap-3">
          <p className="text-body text-ink-muted">{describe(trail.error)}</p>
          <Button
            onClick={() => {
              void trail.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : trail.data === undefined ? (
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-2">
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      ) : entries.length === 0 ? (
        <p className="text-body text-ink-muted">{t('audit.empty')}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-col">
                <span data-audit-line="" className="text-body text-ink">
                  {sentence(entry)}
                </span>
                <time dateTime={entry.createdAt} className="text-caption text-ink-muted">
                  {format.absolute(entry.createdAt)}
                </time>
              </li>
            ))}
          </ul>
          {trail.hasNextPage && (
            <div>
              <Button
                busy={trail.isFetchingNextPage}
                onClick={() => {
                  void trail.fetchNextPage();
                }}
              >
                {t('audit.older')}
              </Button>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
};
