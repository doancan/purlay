/**
 * "Reconnecting…" — one bar, above the main column, and nothing else changes (`UX.md` §8).
 *
 * Shown only for a connection that **has been open and is not now**: the first connect is
 * the page loading, and a bar announcing it on every cold start would be noise about
 * nothing. It is a status, not an alert (it is not asking for anything), and it never
 * disables the composer — messages queue and send on reconnect (`ARCHITECTURE.md` §5.4);
 * disabling input on a network blip is the failure this whole architecture exists to
 * avoid. An ended session is the session gate's business, not a reconnect.
 *
 * The same bar says the other thing that is not "connected": a socket that is open while
 * the server refused to deliver some channels, or a replay that could not be finished. The
 * person would otherwise read a quiet channel as a quiet channel. That one asks for
 * something — Retry — so it is a button in the bar, and the bar is still a status.
 */
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import {
  useConnectedOnce,
  useConnectionStatus,
  useDegraded,
  useEngine,
} from '../../realtime/realtime-provider';

export const ConnectionBar = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const status = useConnectionStatus();
  const degraded = Object.keys(useDegraded()).length;
  const engine = useEngine();
  const wasOpen = useConnectedOnce();

  const down = wasOpen && status !== 'open' && status !== 'ended' && status !== 'idle';
  if (!down && degraded === 0) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 bg-warning px-4 py-1 text-label text-on-status"
    >
      <Icon name="warning" size="sm" />
      {down ? t('connection.reconnecting') : t('connection.degraded', { count: degraded })}
      {!down && (
        <button
          type="button"
          onClick={() => {
            engine.retryDegraded();
          }}
          className="underline"
        >
          {t('common.retry')}
        </button>
      )}
    </div>
  );
};
