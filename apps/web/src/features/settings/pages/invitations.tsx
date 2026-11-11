/**
 * Invitations (D-115, D-146), an owner's or an admin's: make a link to let somebody in, and see and
 * revoke the links still open. A link opens for seven days to anyone signed in who holds it, as a
 * member; the page says so, so nobody shares one thinking it is single-use.
 */
import { InvitationRecipients } from '../invitation-recipients';
import { useI18n } from '../../../i18n/i18n-provider';
import { useAuthMethods } from '../../../data/queries';
import { Button } from '../../../ui/button';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { InvitationForm } from '../../invitations/invitation-form';
import { GuestInvitationSummary } from '../../invitations/guest-invitation-summary';
import { useInvitations } from '../invitations';
import { SettingsCard, SettingsPage } from '../page';

export const InvitationsPage = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const invitations = useInvitations(true);
  const methods = useAuthMethods();
  // A link made here lives in this page's state: shown while the page is open, gone when it is left.
  const { list } = invitations;
  const open = list.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <SettingsPage
      title={t('settings.invitations.title')}
      description={t('settings.invitations.description')}
    >
      <SettingsCard title={t('settings.invitations.new')}>
        <div className="px-6 py-5 max-narrow:px-4">
          <InvitationForm invitations={invitations} methods={methods} />
        </div>
      </SettingsCard>

      <InvitationRecipients />
      <SettingsCard title={t('invite.admin.open')}>
        {list.isError && list.data === undefined ? (
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
        ) : open.length === 0 ? (
          <p className="px-6 py-5 text-body text-ink-muted max-narrow:px-4">
            {t('invite.admin.none')}
          </p>
        ) : (
          <ul aria-label={t('invite.admin.open')} className="flex flex-col">
            {open.map((invitation) => (
              <li
                key={invitation.id}
                className="flex items-center gap-4 not-first:border-t-hairline border-border-subtle px-6 py-3 max-narrow:px-4"
              >
                {/* Whole, never cut: the end of it is the time, and "11:22 …" hides AM from PM. It
                    is also what tells the Revoke beside it from the others. */}
                <div
                  id={`invitation-${invitation.id}`}
                  className="min-w-0 flex-1 text-body text-ink"
                >
                  {t('invite.admin.row', {
                    name: invitation.createdBy?.displayName ?? t('invite.admin.someone'),
                    until: format.absolute(invitation.expiresAt),
                  })}
                  {invitation.guest !== undefined && (
                    <GuestInvitationSummary value={invitation.guest} />
                  )}
                </div>
                <Button
                  variant="dangerQuiet"
                  busy={invitations.revoking.has(invitation.id)}
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
        {list.isError && list.data !== undefined && (
          <div className="flex flex-wrap items-center gap-3 border-t-hairline border-border-subtle px-6 py-3 max-narrow:px-4">
            <p role="alert" className="min-w-0 flex-1 text-label text-danger-text">
              {t(
                list.isFetchNextPageError
                  ? 'settings.invitations.olderFailed'
                  : 'settings.invitations.refreshFailed',
              )}
            </p>
            {!list.isFetchNextPageError && (
              <Button
                busy={list.isFetching}
                onClick={() => {
                  void list.refetch();
                }}
              >
                {t('common.retry')}
              </Button>
            )}
          </div>
        )}
        {list.hasNextPage && (
          <footer className="flex justify-center border-t-hairline border-border-subtle px-6 py-3">
            <Button
              variant="ghost"
              busy={list.isFetchingNextPage}
              disabled={list.isRefetching}
              onClick={() => {
                void list.fetchNextPage();
              }}
            >
              {t('settings.invitations.older')}
            </Button>
          </footer>
        )}
      </SettingsCard>
    </SettingsPage>
  );
};
