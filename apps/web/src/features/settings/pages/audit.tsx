/**
 * The audit trail (D-26), read in the app by an owner or an admin: who did which administrative thing
 * to whom, newest first, a page at a time — so "who removed that member" has an answer without `curl`.
 *
 * Each action the API records (`AUDIT_ACTIONS`) has a sentence, chosen by an exhaustive `switch`, so
 * an action added there without a sentence here does not compile. The
 * wire carries a string, though: an action newer than this client is said by its name, never dropped.
 * People and channels are named from the lists the app already holds; somebody erased, or a channel
 * gone, is said as such. Nothing anybody wrote is here — the trail never had it (D-26).
 *
 * Narrowed by who, which action and which days (D-222) on the server, the filter kept in the page's
 * address (`audit-filter.ts`), and downloaded whole under the same filter as CSV or NDJSON — a link the
 * browser saves, so a long trail never passes through this page's memory.
 */
import { useId } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  AUDIT_ACTIONS,
  AUDIT_EXPORT_FORMATS,
  type AuditAction,
  type AuditEntry,
  type UserRole,
} from '@purlay/types';
import { useApi } from '../../../data/api-provider';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useChannels, useMembers } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { Icon } from '../../../components/icon';
import { Avatar } from '../../../ui/avatar';
import { Button, buttonStyle } from '../../../ui/button';
import { Select } from '../../../ui/select';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { TextField } from '../../../ui/text-field';
import { href } from '../../../router/routes';
import { useRoute } from '../../../router/router-provider';
import { AuthorPicker } from '../../search/author-picker';
import { useSession } from '../../session/session';
import { useWorkspace } from '../../shell/workspace';
import { SettingsCard, SettingsPage } from '../page';
import {
  NO_FILTER,
  auditExportHref,
  auditFilterOf,
  auditSearchOf,
  auditViewIn,
  isBackwards,
  isNarrowed,
  type AuditView,
} from './audit-filter';

const known = (action: string): AuditAction | undefined => AUDIT_ACTIONS.find((a) => a === action);
const roleOf = (word: string | undefined): UserRole | undefined =>
  word === 'member' || word === 'admin' || word === 'owner' ? word : undefined;

export const AuditPage = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const { user: me } = useSession();
  const { search, navigate } = useRoute();
  const members = useMembers(workspace.id);
  const channels = useChannels(workspace.id);
  const view = auditViewIn(search);
  const backwards = isBackwards(view);
  const filter = auditFilterOf(view, format.dayStart);
  const trail = useInfiniteQuery({
    queryKey: keys.audit(workspace.id, filter),
    queryFn: async ({ pageParam, signal }) =>
      await api.audit(workspace.id, filter, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // A window that ends before it starts is said on its field, never asked of the server.
    enabled: !backwards,
  });
  const personId = useId();
  const actionId = useId();
  /** A filter changed: a new address, so Back undoes it and a reload keeps it. */
  const narrow = (next: Partial<AuditView>): void => {
    const query = auditSearchOf({ ...view, ...next });
    const page = href('settings', { slug: workspace.slug, section: 'audit' });
    navigate(query === '' ? page : `${page}?${query}`);
  };
  const chosenName =
    view.actorId === null
      ? null
      : (members.data?.find((m) => m.user.id === view.actorId)?.user.displayName ??
        t('audit.someone'));

  const person = (userId: string | undefined): string =>
    members.data?.find((m) => m.user.id === userId)?.user.displayName ?? t('audit.someoneElse');
  /** A window on the trail: `forever`, or its days — in the reader's words (D-41). */
  const kept = (word: string | undefined): string =>
    word === 'forever' ? t('retention.forever') : t('retention.days', { days: word ?? '' });
  /** A channel's setting on the trail: the workspace's window, `forever`, or its days (D-225). */
  const channelKept = (word: string | undefined): string =>
    word === 'workspace' ? t('audit.workspaceWindow') : kept(word);
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
      case 'channel.restored':
        return t('audit.action.channel.restored', {
          actor,
          channel: `#${entry.metadata['name'] ?? ''}`,
        });
      // Named as a feed's channel is: only one this viewer can see, else "a channel" (#691).
      case 'channel.member_added': {
        const name = channels.data?.find((c) => c.id === entry.metadata['channelId'])?.name;
        const target = person(entry.targetId ?? undefined);
        return name == null
          ? t('audit.action.channel.member_added', { actor, target })
          : t('audit.action.channel.member_added_to', { actor, target, channel: `#${name}` });
      }
      // Named only to a viewer who can see the channel, as a feed's is (D-172).
      case 'channel.member_removed': {
        const target = person(entry.targetId ?? undefined);
        const name = channels.data?.find((c) => c.id === entry.metadata['channelId'])?.name;
        return name == null
          ? t('audit.action.channel.member_removed', { actor, target })
          : t('audit.action.channel.member_removed_from', { actor, target, channel: `#${name}` });
      }
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
      // A hook's channel, named as a feed's is: only one this viewer can see (D-245).
      case 'integration.webhook_created':
      case 'integration.webhook_revoked': {
        const webhook = entry.metadata['name'] ?? '';
        const name = channels.data?.find((c) => c.id === entry.metadata['channelId'])?.name;
        const revoked = entry.action === 'integration.webhook_revoked';
        if (name == null) {
          return revoked
            ? t('audit.action.integration.webhook_revoked', { actor, webhook })
            : t('audit.action.integration.webhook_created', { actor, webhook });
        }
        const channel = `#${name}`;
        return revoked
          ? t('audit.action.integration.webhook_revoked_from', { actor, webhook, channel })
          : t('audit.action.integration.webhook_created_in', { actor, webhook, channel });
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
      // Named only to a viewer who can see the channel, as a feed's is (#691, D-225).
      case 'channel.retention_changed': {
        const name = channels.data?.find((c) => c.id === entry.targetId)?.name;
        const from = channelKept(entry.metadata['from']);
        const to = channelKept(entry.metadata['to']);
        return name == null
          ? t('audit.action.channel.retention_changed', { actor, from, to })
          : t('audit.action.channel.retention_changed_in', {
              actor,
              from,
              to,
              channel: `#${name}`,
            });
      }
      // Named only to a viewer who can see the channel, as a feed's is (#691, D-243).
      case 'channel.posting_changed': {
        const name = channels.data?.find((c) => c.id === entry.targetId)?.name;
        const admins = entry.metadata['to'] === 'admins';
        if (name == null) {
          return admins
            ? t('audit.action.channel.posting_admins', { actor })
            : t('audit.action.channel.posting_everyone', { actor });
        }
        const channel = `#${name}`;
        return admins
          ? t('audit.action.channel.posting_admins_in', { actor, channel })
          : t('audit.action.channel.posting_everyone_in', { actor, channel });
      }
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
      // The operator's command, which is nobody in the workspace (D-173 §4): sizes in the reader's units.
      case 'storage.quota_changed':
        return t('audit.action.storage.quota_changed', {
          from: format.bytes(Number(entry.metadata['from'] ?? '0')),
          to: format.bytes(Number(entry.metadata['to'] ?? '0')),
        });
      // A download of this very log (D-222): who took it; the filter is in the downloaded file's name.
      case 'audit.exported':
        return t('audit.action.audit.exported', { actor });
      // An owner's, read once it was taken back: a workspace being deleted has no trail anybody opens (D-242).
      case 'workspace.deletion_requested': {
        const purgeAt = entry.metadata['purgeAt'];
        return t('audit.action.workspace.deletion_requested', {
          actor,
          when: purgeAt === undefined ? '' : format.absolute(purgeAt),
        });
      }
      case 'workspace.deletion_cancelled':
        return t('audit.action.workspace.deletion_cancelled', { actor });
      case undefined:
        return t('audit.unknown', { actor, action: entry.action });
    }
  };

  const entries = (trail.data?.pages ?? []).flatMap((page) => page.data);

  return (
    <SettingsPage title={t('settings.audit.title')} description={t('audit.description')}>
      <SettingsCard
        title={t('audit.filters')}
        description={t('audit.download.description')}
        footer={
          <>
            {isNarrowed(view) && (
              <Button
                variant="ghost"
                className="mr-auto"
                onClick={() => {
                  narrow(NO_FILTER);
                }}
              >
                {t('audit.filter.clear')}
              </Button>
            )}
            {AUDIT_EXPORT_FORMATS.map((kind) =>
              backwards ? (
                <Button key={kind} glyph="download" disabled>
                  {t(`audit.download.${kind}`)}
                </Button>
              ) : (
                <a
                  key={kind}
                  href={auditExportHref(workspace.id, filter, kind)}
                  download
                  aria-label={t(`audit.download.${kind}Label`)}
                  className={buttonStyle('secondary')}
                >
                  <Icon name="download" size="sm" />
                  {t(`audit.download.${kind}`)}
                </a>
              ),
            )}
          </>
        }
      >
        {/* Two by two on a wide window; one under another, full width, on a phone. */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-6 py-5 max-narrow:grid-cols-1 max-narrow:px-4">
          <div className="flex min-w-0 flex-col gap-1">
            <span id={personId} className="text-label text-ink">
              {t('audit.filter.person')}
            </span>
            <AuthorPicker
              labelId={personId}
              members={members.data ?? []}
              meId={me.id}
              value={view.actorId}
              chosenName={chosenName}
              onChange={(actorId) => {
                narrow({ actorId });
              }}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={actionId} className="text-label text-ink">
              {t('audit.filter.action')}
            </label>
            <Select
              id={actionId}
              value={view.action ?? ''}
              onChange={(event) => {
                narrow({ action: AUDIT_ACTIONS.find((a) => a === event.target.value) ?? null });
              }}
            >
              <option value="">{t('audit.filter.anyAction')}</option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {t(`audit.kind.${action}`)}
                </option>
              ))}
            </Select>
          </div>
          <TextField
            label={t('audit.filter.from')}
            type="date"
            value={view.from ?? ''}
            onChange={(event) => {
              narrow({ from: event.target.value === '' ? null : event.target.value });
            }}
          />
          <TextField
            label={t('audit.filter.to')}
            type="date"
            value={view.to ?? ''}
            {...(view.from === null ? {} : { min: view.from })}
            {...(backwards
              ? { error: t('audit.filter.backwards') }
              : { hint: t('audit.filter.dateHint') })}
            onChange={(event) => {
              narrow({ to: event.target.value === '' ? null : event.target.value });
            }}
          />
        </div>
      </SettingsCard>
      {/* A backwards window is said on its field and asks nothing: there is no list to show. */}
      {!backwards && (
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
            <p className="px-6 py-5 text-body text-ink-muted max-narrow:px-4">
              {isNarrowed(view) ? t('audit.emptyFiltered') : t('audit.empty')}
            </p>
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
          {/* An older page that failed says so where it was asked for: silent, "the end of the log" and
            "the request failed" looked the same. The button below asks again. */}
          {trail.isFetchNextPageError && (
            <p
              role="alert"
              className="flex items-center gap-2 border-t-hairline border-border-subtle px-6 py-3 text-label text-danger-text max-narrow:px-4"
            >
              <Icon name="failed" size="sm" />
              {`${t('audit.olderFailed')} ${describe(trail.error)}`}
            </p>
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
      )}
    </SettingsPage>
  );
};
