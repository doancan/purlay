/**
 * Members and roles (`ARCHITECTURE.md` §7.4, D-111): an owner's or an admin's place to change who is
 * an admin and to take somebody out of the workspace (`PRD.md` §4.3).
 *
 * What is offered is what the server would allow, so nothing here is refused for being forbidden: an
 * admin manages members and admins and does not touch an owner's row or make an owner; an owner does
 * all of it. Nobody changes their own row — the way to stop being an owner is another owner. The
 * server stays the authority: the last owner (I-2) comes back as `LAST_OWNER` and is said in words,
 * and the list is read again after every change, so what is shown is what the server kept.
 *
 * Removing someone costs them every channel at once, so it asks first, in the row itself.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { UserRole, WorkspaceMember } from '@purlay/types';
import { useState } from 'react';
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';

const ROLES: readonly UserRole[] = ['member', 'admin', 'owner'];

export const MembersDialog = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const { user, memberships } = useSession();
  const members = useMembers(workspace.id);
  const [asking, setAsking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const actor = memberships.find((m) => m.workspace.id === workspace.id)?.role;

  const reread = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.members(workspace.id) });
  };

  const change = (next: boolean): void => {
    if (!next) {
      setAsking(null);
      setProblem(null);
    }
    onOpenChange(next);
  };

  /** What this person may do to a row: nothing to their own, nothing to an owner's unless an owner. */
  const mayManage = (member: WorkspaceMember): boolean =>
    member.user.id !== user.id &&
    (actor === 'owner' || (actor === 'admin' && member.role !== 'owner'));
  const offered = ROLES.filter((role) => actor === 'owner' || role !== 'owner');

  const setRole = async (member: WorkspaceMember, role: UserRole): Promise<void> => {
    setProblem(null);
    try {
      await api.updateMemberRole(workspace.id, member.user.id, role);
    } catch (failure) {
      setProblem(
        isApiError(failure) && failure.code === 'LAST_OWNER'
          ? t('members.lastOwner')
          : `${t('members.roleFailed')} ${describe(failure)}`,
      );
    }
    // Either way, what is shown is what the server kept.
    await reread();
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

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={t('members.title', { workspace: workspace.name })}
      description={t('members.description')}
      closeLabel={t('common.close')}
    >
      {problem !== null && (
        <p role="alert" className="text-label text-danger-text">
          {problem}
        </p>
      )}
      {members.isError ? (
        <div className="flex items-center gap-3">
          <p className="text-body text-ink-muted">{describe(members.error)}</p>
          <Button
            onClick={() => {
              void members.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : members.data === undefined ? (
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-2">
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      ) : (
        <ul className="flex flex-col gap-2">
          {members.data.map((member) => {
            const name = member.user.displayName;
            const manage = mayManage(member);
            return (
              <li key={member.user.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-3">
                  <Avatar name={name} username={member.user.username} size="md" />
                  <span className="min-w-0 flex-1 text-body text-ink">
                    {name}{' '}
                    <span className="text-caption text-ink-muted">
                      @{member.user.username}
                      {member.user.id === user.id && ` · ${t('members.you')}`}
                    </span>
                  </span>
                  {manage ? (
                    <>
                      <select
                        aria-label={t('members.roleOf', { name })}
                        value={member.role}
                        onChange={(event) => {
                          const next = ROLES.find((role) => role === event.target.value);
                          if (next !== undefined) void setRole(member, next);
                        }}
                        className="rounded-md border-hairline border-border-subtle bg-surface-000 px-2 py-1 text-label text-ink"
                      >
                        {offered.map((role) => (
                          <option key={role} value={role}>
                            {t(`members.role.${role}`)}
                          </option>
                        ))}
                      </select>
                      <Button
                        aria-label={t('members.removeLabel', { name })}
                        onClick={() => {
                          setAsking(member.user.id);
                        }}
                      >
                        {t('members.remove')}
                      </Button>
                    </>
                  ) : (
                    <span className="text-label text-ink-muted">
                      {t(`members.role.${member.role}`)}
                    </span>
                  )}
                </div>
                {asking === member.user.id && (
                  <div className="flex items-center gap-2 pl-8">
                    <p className="min-w-0 flex-1 text-label text-ink">
                      {t('members.removeAsk', { name })}
                    </p>
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
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
};
