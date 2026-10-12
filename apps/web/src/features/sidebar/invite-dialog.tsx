/**
 * Invite people (D-115, `UX.md` §2): an owner's or an admin's place to make a link, copy it, and see
 * and revoke the links still open. The workspace menu offers it to them alone; the server refuses a
 * member anyway.
 *
 * A link's token is in the answer that makes it and never again, so the link is shown here once,
 * whole, to be copied — and the list after it names who made each link and until when, never the
 * link itself. Revoking is immediate on the server; the list is read again after it.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { useToast } from '../../ui/toast';
import { useContentPorts } from '../content/content-ports';
import { useWorkspace } from '../shell/workspace';

export const InviteDialog = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { show } = useToast();
  const { copy } = useContentPorts();
  const { workspace } = useWorkspace();
  const [link, setLink] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const list = useQuery({
    queryKey: keys.invitations(workspace.id),
    queryFn: async ({ signal }) => await api.invitations(workspace.id, undefined, signal),
    enabled: open,
  });
  const reread = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.invitations(workspace.id) });
  };

  const change = (next: boolean): void => {
    // What was made is shown once: closing the dialog lets it go.
    if (!next) {
      setLink(null);
      setProblem(null);
    }
    onOpenChange(next);
  };

  const make = async (): Promise<void> => {
    setMaking(true);
    setProblem(null);
    try {
      const { token } = await api.createInvitation(workspace.id);
      setLink(`${window.location.origin}/invite#${token}`);
      await reread();
    } catch (failure) {
      setProblem(`${t('invite.admin.makeFailed')} ${describe(failure)}`);
    } finally {
      setMaking(false);
    }
  };

  const revoke = async (invitationId: string): Promise<void> => {
    try {
      await api.revokeInvitation(workspace.id, invitationId);
      await reread();
    } catch (failure) {
      show({ message: `${t('invite.admin.revokeFailed')} ${describe(failure)}` });
    }
  };

  const copyLink = (text: string): void => {
    copy(text).then(
      () => {
        show({ message: t('common.copied') });
      },
      () => {
        show({ message: t('failure.copy') });
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={t('invite.admin.title', { workspace: workspace.name })}
      description={t('invite.admin.description')}
      closeLabel={t('common.close')}
    >
      <div className="flex flex-col gap-3">
        <div>
          <Button
            variant="primary"
            busy={making}
            onClick={() => {
              void make();
            }}
          >
            {t('invite.admin.make')}
          </Button>
        </div>
        {problem !== null && (
          <p role="alert" className="text-label text-danger-text">
            {problem}
          </p>
        )}
        {link !== null && (
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={link}
              aria-label={t('invite.admin.link')}
              className="min-w-0 flex-1 rounded-md border-hairline border-border-subtle bg-surface-000 px-2 py-1 font-mono text-caption text-ink"
              onFocus={(event) => {
                event.target.select();
              }}
            />
            <Button
              onClick={() => {
                copyLink(link);
              }}
            >
              {t('common.copy')}
            </Button>
          </div>
        )}
      </div>
      <section className="flex flex-col gap-2">
        <h3 className="text-label font-semibold text-ink">{t('invite.admin.open')}</h3>
        {list.isError ? (
          <div className="flex items-center gap-3">
            <p className="text-body text-ink-muted">{describe(list.error)}</p>
            <Button
              onClick={() => {
                void list.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : list.data === undefined ? (
          <LoadingStatus label={t('common.loading')} className="flex flex-col gap-2">
            <Skeleton />
            <Skeleton />
          </LoadingStatus>
        ) : list.data.data.length === 0 ? (
          <p className="text-body text-ink-muted">{t('invite.admin.none')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {list.data.data.map((invitation) => (
              <li key={invitation.id} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-body text-ink">
                  {t('invite.admin.row', {
                    name: invitation.createdBy?.displayName ?? t('invite.admin.someone'),
                    until: format.absolute(invitation.expiresAt),
                  })}
                </span>
                <Button
                  onClick={() => {
                    void revoke(invitation.id);
                  }}
                >
                  {t('invite.admin.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Dialog>
  );
};
