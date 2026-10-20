/**
 * Members (`ARCHITECTURE.md` §7.4, D-111, D-146): an owner's or an admin's page to see who is in the
 * workspace, change who is an admin, and take somebody out (`PRD.md` §4.3).
 *
 * What is offered is what the server would allow, so nothing here is refused for being forbidden: an
 * admin manages members and admins and does not touch an owner's row or make an owner; an owner does
 * all of it. A person's own role is theirs to change too — an owner steps down once there is another
 * — asked in the row first, since only somebody else can change it back; removing oneself is leaving,
 * not offered here. The server stays the authority: the last owner (I-2) comes back as `LAST_OWNER` and is said in words,
 * and the list is read again after every change, so what is shown is what the server kept.
 *
 * Removing someone costs them every channel at once, so it asks first, in the row itself. The list is
 * searched by name or handle and filtered by role here, in the page: a workspace is a team (`PRD.md`
 * §3), so all of it is already in hand.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { UserRole, WorkspaceMember } from '@purlay/types';
import { useId, useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { isApiError } from '../../../data/errors';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useMembers } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { Link } from '../../../router/router-provider';
import { buttonStyle, Button } from '../../../ui/button';
import { Avatar } from '../../../ui/avatar';
import { Select } from '../../../ui/select';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { Icon } from '../../../components/icon';
import { VisuallyHidden } from '../../../ui/visually-hidden';
import { fold } from '../../composer/mention-suggest';
import { useSession } from '../../session/session';
import { useWorkspace } from '../../shell/workspace';
import { SaveOutcome, SettingsCard, SettingsPage } from '../page';
import { useWorkspaceRole } from '../role';

const ROLES: readonly UserRole[] = ['owner', 'admin', 'member'];
const ALL = 'all';

const RoleGuide = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <SettingsCard title={t('settings.members.guide')}>
      <dl className="flex flex-col">
        {ROLES.map((role) => (
          <div
            key={role}
            className="flex gap-6 not-first:border-t-hairline border-border-subtle px-6 py-4 max-narrow:flex-col max-narrow:gap-1 max-narrow:px-4"
          >
            <dt className="w-1/4 shrink-0 text-label text-ink max-narrow:w-auto">
              {t(`members.role.${role}`)}
            </dt>
            <dd className="min-w-0 flex-1 text-label font-normal text-ink-muted">
              {t(`settings.members.can.${role}`)}
            </dd>
          </div>
        ))}
      </dl>
    </SettingsCard>
  );
};

export const MembersPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const searchId = useId();
  const { workspace } = useWorkspace();
  const { user } = useSession();
  const members = useMembers(workspace.id);
  const actor = useWorkspaceRole();
  const [asking, setAsking] = useState<string | null>(null);
  // A role the person chose for their own row, asked about in the row before it is sent: they may not
  // be able to change it back themself (D-111).
  const [stepping, setStepping] = useState<UserRole | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<UserRole | typeof ALL>(ALL);

  const reread = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.members(workspace.id) });
  };

  /**
   * Whose role this person may change (D-111): an owner's only if an owner — their own included, so an
   * owner steps down once there is another — and an admin anyone else's, themself included.
   */
  const mayChangeRole = (member: WorkspaceMember): boolean =>
    actor === 'owner' || (actor === 'admin' && member.role !== 'owner');
  /** Whom this person may remove: as above, but never themself — that is leaving (Sessions & account). */
  const mayRemove = (member: WorkspaceMember): boolean =>
    member.user.id !== user.id && mayChangeRole(member);
  const offered = ROLES.filter((option) => actor === 'owner' || option !== 'owner');

  const changeRole = async (member: WorkspaceMember, next: UserRole): Promise<void> => {
    setProblem(null);
    try {
      await api.updateMemberRole(workspace.id, member.user.id, next);
    } catch (failure) {
      setProblem(
        isApiError(failure) && failure.code === 'LAST_OWNER'
          ? t('members.lastOwner')
          : `${t('members.roleFailed')} ${describe(failure)}`,
      );
    }
    // Either way, what is shown is what the server kept; and changing one's own role changes what this
    // person may open, which the session says.
    await reread();
    if (member.user.id === user.id) await client.invalidateQueries({ queryKey: keys.me });
  };

  const remove = async (member: WorkspaceMember): Promise<void> => {
    setProblem(null);
    setAsking(null);
    try {
      await api.removeMember(workspace.id, member.user.id);
    } catch (failure) {
      setProblem(
        isApiError(failure) && failure.code === 'LAST_OWNER'
          ? t('members.lastOwner')
          : `${t('members.removeFailed', { name: member.user.displayName })} ${describe(failure)}`,
      );
    }
    await reread();
  };

  const all = members.data ?? [];
  const wanted = fold(query.trim());
  const shown = all
    .filter((member) => role === ALL || member.role === role)
    .filter(
      (member) =>
        wanted === '' ||
        fold(member.user.displayName).includes(wanted) ||
        fold(member.user.username).includes(wanted),
    )
    .sort(
      (a, b) =>
        ROLES.indexOf(a.role) - ROLES.indexOf(b.role) ||
        a.user.displayName.localeCompare(b.user.displayName),
    );
  const count = (of: UserRole): number => all.filter((member) => member.role === of).length;

  return (
    <SettingsPage
      title={t('settings.members.title')}
      description={t('members.description')}
      action={
        <Link
          to="settings"
          params={{ slug: workspace.slug, section: 'invitations' }}
          className={buttonStyle('primary')}
        >
          <Icon name="invite" />
          {t('settings.members.invite')}
        </Link>
      }
    >
      {members.data !== undefined && (
        <dl className="grid grid-cols-4 overflow-hidden rounded-xl border-hairline border-border-subtle bg-surface-100 shadow-card">
          {(
            [
              ['total', all.length],
              ['owner', count('owner')],
              ['admin', count('admin')],
              ['member', count('member')],
            ] as const
          ).map(([kind, value]) => (
            <div
              key={kind}
              className="flex min-w-0 flex-col gap-1 not-first:border-l-hairline border-border-subtle px-6 py-4 max-narrow:px-3"
            >
              <dt className="truncate text-caption text-ink-muted">
                {t(`settings.members.count.${kind}`)}
              </dt>
              <dd className="font-mono text-title text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <SettingsCard
        {...(problem === null
          ? {}
          : { footer: <SaveOutcome outcome={{ ok: false, words: problem }} /> })}
      >
        <div className="flex items-center gap-3 border-b-hairline border-border-subtle px-6 py-3 max-narrow:flex-col max-narrow:items-stretch max-narrow:px-4">
          <label htmlFor={searchId} className="relative flex min-w-0 flex-1 items-center">
            <span className="pointer-events-none absolute left-3 text-ink-muted">
              <Icon name="search" size="sm" />
            </span>
            <VisuallyHidden>{t('settings.members.search')}</VisuallyHidden>
            <input
              id={searchId}
              type="search"
              value={query}
              placeholder={t('settings.members.search')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              className="h-control w-full rounded-md border-hairline border-border-strong bg-surface-100 pr-3 pl-8 text-body text-ink placeholder:text-ink-muted max-narrow:h-touch"
            />
          </label>
          <Select
            aria-label={t('settings.members.filter')}
            value={role}
            onChange={(event) => {
              const next = ROLES.find((option) => option === event.target.value);
              setRole(next ?? ALL);
            }}
          >
            <option value={ALL}>{t('settings.members.everyRole')}</option>
            {ROLES.map((option) => (
              <option key={option} value={option}>
                {t(`members.role.${option}`)}
              </option>
            ))}
          </Select>
        </div>

        {members.isError ? (
          <div className="flex items-center gap-3 px-6 py-5 max-narrow:px-4">
            <p className="min-w-0 flex-1 text-body text-ink-muted">{describe(members.error)}</p>
            <Button
              onClick={() => {
                void members.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : members.data === undefined ? (
          <LoadingStatus label={t('common.loading')} className="flex flex-col gap-3 px-6 py-5">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </LoadingStatus>
        ) : shown.length === 0 ? (
          <p className="px-6 py-8 text-center text-body text-ink-muted">
            {t('settings.members.noMatch')}
          </p>
        ) : (
          <ul aria-label={t('settings.members.title')} className="flex flex-col">
            {shown.map((member) => {
              const name = member.user.displayName;
              const manage = mayChangeRole(member);
              const removable = mayRemove(member);
              const you = member.user.id === user.id;
              return (
                <li
                  key={member.user.id}
                  className="flex flex-col not-first:border-t-hairline border-border-subtle"
                >
                  <div className="flex items-center gap-4 px-6 py-3 max-narrow:flex-wrap max-narrow:px-4">
                    <Avatar name={name} username={member.user.username} size="md" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-2 truncate text-label text-ink">
                        {name}
                        {you && (
                          <span className="inline-flex h-badge items-center rounded-pill bg-surface-200 px-2 text-caption text-ink-muted">
                            {t('members.you')}
                          </span>
                        )}
                      </span>
                      <span className="truncate font-mono text-caption text-ink-muted">
                        @{member.user.username}
                      </span>
                    </span>
                    {/* Role and action as two columns of one width on every row, so an owner's role in
                        words sits where another row's select does. */}
                    <span className="grid w-full max-w-field shrink-0 grid-cols-2 items-center gap-2 max-narrow:max-w-none">
                      {manage ? (
                        <Select
                          aria-label={t('members.roleOf', { name })}
                          value={member.role}
                          className="w-full"
                          onChange={(event) => {
                            const next = ROLES.find((option) => option === event.target.value);
                            if (next === undefined || next === member.role) return;
                            if (you) setStepping(next);
                            else void changeRole(member, next);
                          }}
                        >
                          {offered.map((option) => (
                            <option key={option} value={option}>
                              {t(`members.role.${option}`)}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        // Beside a column of menus, under their words; on a phone, at the row's edge as they are.
                        <span className="pl-3 text-label font-normal text-ink-muted max-narrow:pl-0">
                          {t(`members.role.${member.role}`)}
                        </span>
                      )}
                      {removable && (
                        <span className="flex justify-end">
                          <Button
                            variant="dangerQuiet"
                            aria-label={t('members.removeLabel', { name })}
                            onClick={() => {
                              setAsking(member.user.id);
                            }}
                          >
                            {t('members.remove')}
                          </Button>
                        </span>
                      )}
                    </span>
                  </div>
                  {you && stepping !== null && (
                    <div className="flex items-center gap-3 bg-warning-subtle px-6 py-3 max-narrow:flex-col max-narrow:items-stretch max-narrow:px-4">
                      <p className="min-w-0 flex-1 text-label text-warning-text">
                        {t('members.selfAsk', { role: t(`members.role.${stepping}`) })}
                      </p>
                      <span className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setStepping(null);
                          }}
                        >
                          {t('common.cancel')}
                        </Button>
                        <Button
                          variant="primary"
                          onClick={() => {
                            const next = stepping;
                            setStepping(null);
                            void changeRole(member, next);
                          }}
                        >
                          {t('members.selfConfirm')}
                        </Button>
                      </span>
                    </div>
                  )}
                  {asking === member.user.id && (
                    <div className="flex items-center gap-3 bg-danger-subtle px-6 py-3 max-narrow:flex-col max-narrow:items-stretch max-narrow:px-4">
                      <p className="min-w-0 flex-1 text-label text-danger-text">
                        {t('members.removeAsk', { name })}
                      </p>
                      <span className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setAsking(null);
                          }}
                        >
                          {t('common.cancel')}
                        </Button>
                        <Button
                          variant="danger"
                          onClick={() => {
                            void remove(member);
                          }}
                        >
                          {t('members.remove')}
                        </Button>
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsCard>

      <RoleGuide />
    </SettingsPage>
  );
};
