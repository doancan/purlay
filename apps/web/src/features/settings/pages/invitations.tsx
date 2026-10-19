/**
 * Invitations (D-115, D-146), an owner's or an admin's: make a link to let somebody in, and see and
 * revoke the links still open. A link opens for seven days to anyone signed in who holds it, as a
 * member; the page says so, so nobody shares one thinking it is single-use.
 */
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { MadeLink, useInvitations } from '../invitations';
import { SaveOutcome, SettingsCard, SettingsPage, SettingsRow } from '../page';

export const InvitationsPage = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const invitations = useInvitations(true);
  // A link made here lives in this page's state: shown while the page is open, gone when it is left.
  const { list } = invitations;

  return (
    <SettingsPage
      title={t('settings.invitations.title')}
      description={t('settings.invitations.description')}
    >
      <SettingsCard
        title={t('settings.invitations.new')}
        description={t('settings.invitations.newHint')}
        {...(invitations.problem === null
          ? {}
          : {
              footer: <SaveOutcome outcome={{ ok: false, words: invitations.problem }} />,
            })}
      >
        <SettingsRow label={t('invite.admin.link')} wide={invitations.link !== null}>
          {invitations.link === null ? (
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
          ) : (
            <MadeLink link={invitations.link} onCopy={invitations.copyLink} />
          )}
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t('invite.admin.open')}>
        {list.isError ? (
          <div className="flex items-center gap-3 px-6 py-5 max-narrow:px-4">
            <p className="min-w-0 flex-1 text-body text-ink-muted">
              {t('settings.invitations.failed')}
            </p>
            <Button
              onClick={() => {
                void list.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : list.data === undefined ? (
          <LoadingStatus label={t('common.loading')} className="flex flex-col gap-3 px-6 py-5">
            <Skeleton />
            <Skeleton />
          </LoadingStatus>
        ) : list.data.data.length === 0 ? (
          <p className="px-6 py-5 text-body text-ink-muted max-narrow:px-4">
            {t('invite.admin.none')}
          </p>
        ) : (
          <ul className="flex flex-col">
            {list.data.data.map((invitation) => (
              <li
                key={invitation.id}
                className="flex items-center gap-4 not-first:border-t-hairline border-border-subtle px-6 py-3 max-narrow:px-4"
              >
                {/* Whole, never cut: the end of it is the time, and "11:22 …" hides AM from PM. It
                    is also what tells the Revoke beside it from the others. */}
                <span
                  id={`invitation-${invitation.id}`}
                  className="min-w-0 flex-1 text-body text-ink"
                >
                  {t('invite.admin.row', {
                    name: invitation.createdBy?.displayName ?? t('invite.admin.someone'),
                    until: format.absolute(invitation.expiresAt),
                  })}
                </span>
                <Button
                  variant="dangerQuiet"
                  aria-describedby={`invitation-${invitation.id}`}
                  onClick={() => {
                    void invitations.revoke(invitation.id);
                  }}
                >
                  {t('invite.admin.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </SettingsPage>
  );
};
