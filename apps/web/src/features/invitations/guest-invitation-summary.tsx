import type { InvitationGuestAccess } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';

/** Count-only scope: private conversation identities never appear in a link preview. */
export const GuestInvitationSummary = ({
  value,
  history = false,
}: {
  readonly value: InvitationGuestAccess;
  readonly history?: boolean;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  return (
    <div className="flex flex-col gap-1 text-caption text-ink-muted">
      <p>{t('invite.guest.scope', { count: value.channelCount })}</p>
      {history && <p>{t('invite.guest.history')}</p>}
      <p>
        {value.accessExpiresAt === null
          ? t('invite.guest.noEnd')
          : t('invite.guest.ends', { at: format.absolute(value.accessExpiresAt) })}
      </p>
    </div>
  );
};
