/**
 * Invite people (D-115, D-146, D-179 §5, `UX.md` §2, §8): the quick way, from the workspace menu — make
 * a link and copy it, without leaving the conversation; where the server can send mail, also send it to
 * addresses typed as chips. The links still open, and revoking them, are the Invitations page's, which
 * this dialog links to. An owner's or an admin's; the server refuses a member anyway.
 *
 * **Whether mail can be sent is the sign-in methods' answer** (`/api/auth/methods`, which already says
 * it for the sign-in screen), so no new request or field: the same fact has one home. Loading, an unavailable relay, and a failed check
 * are said beside the fallback link action.
 *
 * **Said in the words of what happened.** A send answers per address, and the server only *queued* the
 * letters — handing them to the mail server happens after its answer — so the screen says the mail
 * server was asked, never that anything arrived; what was refused is named with the reason; and the link
 * is shown whatever happened, so a message that fails is not a dead end.
 */
import { useAuthMethods } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { Link } from '../../../router/router-provider';
import { Dialog } from '../../../ui/dialog';
import { InvitationForm } from '../../invitations/invitation-form';
import { useInvitations } from '../../settings/invitations';
import { useWorkspace } from '../../shell/workspace';

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
  // Asked while the dialog is open, not when the menu is drawn.
  const methods = useAuthMethods(open);
  const mail = methods.data?.email === true;

  const change = (next: boolean): void => {
    if (!next) invitations.forget();
    onOpenChange(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={t('invite.admin.title', { workspace: workspace.name })}
      description={t(mail ? 'invite.mail.description' : 'invite.admin.description')}
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
      <InvitationForm invitations={invitations} methods={methods} />
    </Dialog>
  );
};
