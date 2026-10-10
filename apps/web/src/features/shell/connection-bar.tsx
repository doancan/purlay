/**
 * "Reconnecting…" — one bar, above the main column, and nothing else changes (`UX.md` §8).
 *
 * Shown only for a connection that **has been open and is not now**: the first connect is
 * the page loading, and a bar announcing it on every cold start would be noise about
 * nothing. It is a status, not an alert (it is not asking for anything), and it never
 * disables the composer — messages queue and send on reconnect (`ARCHITECTURE.md` §5.4);
 * disabling input on a network blip is the failure this whole architecture exists to
 * avoid. An ended session is the session gate's business, not a reconnect.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { useConnectionStatus } from '../../realtime/realtime-provider';

export const ConnectionBar = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const status = useConnectionStatus();
  const [wasOpen, setWasOpen] = useState(false);

  useEffect(() => {
    if (status === 'open') setWasOpen(true);
  }, [status]);

  if (!wasOpen || status === 'open' || status === 'ended' || status === 'idle') return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 bg-warning px-4 py-1 text-label text-on-status"
    >
      <Icon name="warning" size="sm" />
      {t('connection.reconnecting')}
    </div>
  );
};
