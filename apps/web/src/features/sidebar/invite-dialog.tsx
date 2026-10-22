/**
 * Invite people (D-115, D-146, D-179 §5, `UX.md` §2, §8): the quick way, from the workspace menu — make
 * a link and copy it, without leaving the conversation; where the server can send mail, also send it to
 * addresses typed as chips. The links still open, and revoking them, are the Invitations page's, which
 * this dialog links to. An owner's or an admin's; the server refuses a member anyway.
 *
 * **Whether mail can be sent is the sign-in methods' answer** (`/api/auth/methods`, which already says
 * it for the sign-in screen), so no new request or field: the same fact has one home. Until it has
 * answered, or where it says no, the dialog is the link alone, as it was.
 *
 * **Said in the words of what happened.** A send answers per address, and the server only *queued* the
 * letters — handing them to the mail server happens after its answer — so the screen says the mail
 * server was asked, never that anything arrived; what was refused is named with the reason; and the link
 * is shown whatever happened, so a message that fails is not a dead end.
 */
import {
  INVITATION_EMAILS_PER_INVITER_PER_DAY,
  INVITATION_EMAILS_PER_REQUEST,
  INVITATION_EMAILS_PER_WORKSPACE_PER_DAY,
  type InvitationMailResult,
} from '@purlay/types';
import { useState } from 'react';
import { useAuthMethods } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Link } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { MadeLink, useInvitations, type Invitations } from '../settings/invitations';
import { useWorkspace } from '../shell/workspace';
import { AddressChips, sendable } from './address-chips';

/** What became of the addresses, one sentence for each thing that happened. */
const MailOutcome = ({
  results,
}: {
  readonly results: readonly InvitationMailResult[];
}): React.JSX.Element => {
  const { t } = useI18n();
  const named = (outcome: InvitationMailResult['outcome']): string =>
    results
      .filter((result) => result.outcome === outcome)
      .map((result) => result.address)
      .join(', ');
  const queued = results.filter((result) => result.outcome === 'queued').length;
  const refusals = [
    ['invalid', t('invite.mail.invalid', { addresses: named('invalid') })],
    [
      'inviter_limit',
      t('invite.mail.inviterLimit', {
        limit: INVITATION_EMAILS_PER_INVITER_PER_DAY,
        addresses: named('inviter_limit'),
      }),
    ],
    [
      'workspace_limit',
      t('invite.mail.workspaceLimit', {
        limit: INVITATION_EMAILS_PER_WORKSPACE_PER_DAY,
        addresses: named('workspace_limit'),
      }),
    ],
    ['unavailable', t('invite.mail.unavailable', { addresses: named('unavailable') })],
  ] as const;
  return (
    <div role="status" className="flex flex-col gap-1 text-label">
      {queued > 0 && (
        <p className="text-ink">
          {t('invite.mail.queued', { count: queued })}{' '}
          <span className="text-ink-muted">{t('invite.mail.queuedNote')}</span>
        </p>
      )}
      {refusals.map(([outcome, words]) =>
        results.some((result) => result.outcome === outcome) ? (
          <p key={outcome} className="text-danger-text">
            {words}
          </p>
        ) : null,
      )}
    </div>
  );
};

/** The addresses and the button that sends the link to them; shown only where mail can be sent. */
const MailForm = ({ invitations }: { readonly invitations: Invitations }): React.JSX.Element => {
  const { t, locale } = useI18n();
  const [addresses, setAddresses] = useState<readonly string[]>([]);
  const valid = sendable(addresses);

  const send = async (): Promise<void> => {
    const sent = await invitations.make({ emails: valid, locale });
    // Only the addresses that were refused stay, so nothing leaves the field unsaid; the rest are
    // on their way and the sentence below says so.
    setAddresses((now) =>
      sent === undefined
        ? now
        : now.filter((address) => {
            const stored = sendable([address])[0];
            const result = sent.find((found) => found.address === stored);
            return result?.outcome !== 'queued';
          }),
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <AddressChips
        label={t('invite.mail.label')}
        hint={t('invite.mail.hint')}
        placeholder={t('invite.mail.placeholder')}
        removeLabel={(address) => t('invite.mail.remove', { address })}
        invalidLabel={t('invite.mail.invalidChip')}
        tooMany={t('invite.mail.tooMany', { max: INVITATION_EMAILS_PER_REQUEST })}
        addresses={addresses}
        onChange={setAddresses}
        max={INVITATION_EMAILS_PER_REQUEST}
        disabled={invitations.making}
      />
      <div>
        <Button
          variant="primary"
          glyph="send"
          busy={invitations.making}
          disabled={valid.length === 0}
          onClick={() => {
            void send();
          }}
        >
          {valid.length === 0
            ? t('invite.mail.sendNone')
            : t('invite.mail.send', { count: valid.length })}
        </Button>
      </div>
      {invitations.mail !== null && <MailOutcome results={invitations.mail} />}
    </div>
  );
};

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
  const mail = useAuthMethods(open).data?.email === true;

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
      <InviteBody invitations={invitations} mail={mail} />
    </Dialog>
  );
};

const InviteBody = ({
  invitations,
  mail,
}: {
  readonly invitations: Invitations;
  readonly mail: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3">
      {mail && <MailForm invitations={invitations} />}
      {mail && <p className="text-label text-ink-muted">{t('invite.mail.or')}</p>}
      {invitations.link === null ? (
        <div>
          <Button
            variant={mail ? 'secondary' : 'primary'}
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
  );
};
