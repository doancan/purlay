/**
 * Invite people (D-115, D-146): the quick way, from the workspace menu — make a link and copy it,
 * without leaving the conversation. The links still open, and revoking them, are the Invitations
 * page's, which this dialog links to. An owner's or an admin's; the server refuses a member anyway.
 */
import { useI18n } from '../../i18n/i18n-provider';
import { Link } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { MadeLink, useInvitations } from '../settings/invitations';
import { useWorkspace } from '../shell/workspace';

export const InviteDialog = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const invitations = useInvitations(false);

  const change = (next: boolean): void => {
    if (!next) invitations.forget();
    onOpenChange(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={t('invite.admin.title', { workspace: workspace.name })}
      description={t('invite.admin.description')}
      closeLabel={t('common.close')}
      footer={
        <Link
          to="settings"
          params={{ slug: workspace.slug, section: 'invitations' }}
          onClick={() => {
            change(false);
          }}
          className="mr-auto text-label text-accent-text hover:underline"
        >
          {t('settings.invitations.manage')}
        </Link>
      }
    >
      <div className="flex flex-col gap-3">
        {invitations.link === null ? (
          <div>
            <Button
              variant="primary"
              glyph="invite"
              busy={invitations.making}
              onClick={() => {
                void invitations.make();
              }}
            >
              {t('invite.admin.make')}
            </Button>
          </div>
        ) : (
          <MadeLink link={invitations.link} onCopy={invitations.copyLink} />
        )}
        {invitations.problem !== null && (
          <p role="alert" className="text-label text-danger-text">
            {invitations.problem}
          </p>
        )}
      </div>
    </Dialog>
  );
};
