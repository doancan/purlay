/**
 * Where you are signed in (D-193): each live session of the person's, the one used last first, and *Sign
 * out* on every one but this.
 *
 * A session is named as the server names it and by nothing it does not say: the Mac's own name, or
 * *Web browser* — never a guess from a user agent — told apart by when it was signed in and last used.
 * The session this page runs in is marked *This device* and has no button of its own: ending it is
 * signing out, which the card below offers in those words.
 *
 * Signing one out is taken off the list at once and put back if refused, as a bookmark is (D-218), and
 * asks nothing first: what it costs is signing in again on that device. A session already ended — by
 * that device, by its expiry, by another tab — is what was asked for, so `SESSION_NOT_FOUND` says
 * nothing; either way the list is read again, so what is shown is what the server kept.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { DeviceSession, DeviceSessionList } from '@purlay/types';
import { useRef } from 'react';
import { useApi } from '../../../data/api-provider';
import { isApiError } from '../../../data/errors';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useMySessions } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useToast } from '../../../ui/toast';
import { SettingsCard } from '../page';

export const DevicesCard = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const sessions = useMySessions();
  // A row signed out takes its button with it: focus goes to the list, which says what is left.
  const list = useRef<HTMLUListElement>(null);

  const nameOf = (session: DeviceSession): string =>
    session.kind === 'native'
      ? (session.name ?? t('settings.devices.native'))
      : t('settings.devices.browser');

  const signOut = (session: DeviceSession): void => {
    const device = nameOf(session);
    client.setQueryData<DeviceSessionList>(keys.mySessions, (held) =>
      held === undefined ? held : { data: held.data.filter((each) => each.id !== session.id) },
    );
    list.current?.focus();
    api.endMySession(session.id).then(
      () => {
        show({ message: t('settings.devices.signedOut', { device }) });
        void client.invalidateQueries({ queryKey: keys.mySessions, exact: true });
      },
      (failure: unknown) => {
        // Put back as the server has it: ended meanwhile by somebody else is still ended.
        void client.invalidateQueries({ queryKey: keys.mySessions, exact: true });
        if (isApiError(failure) && failure.code === 'SESSION_NOT_FOUND') return;
        show({
          message: `${t('settings.devices.signOutFailed', { device })} ${describe(failure)}`,
        });
      },
    );
  };

  const others = sessions.data?.data.filter((session) => !session.current) ?? [];

  return (
    <SettingsCard
      title={t('settings.devices.title')}
      description={t('settings.devices.description')}
    >
      {sessions.isError ? (
        <div className="flex items-center gap-3 px-6 py-5 max-narrow:px-4">
          <p className="min-w-0 flex-1 text-body text-ink-muted">
            {t('settings.devices.failed')} {describe(sessions.error)}
          </p>
          <Button
            onClick={() => {
              void sessions.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : sessions.data === undefined ? (
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-3 px-6 py-5">
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      ) : (
        <>
          <ul
            ref={list}
            tabIndex={-1}
            aria-label={t('settings.devices.list')}
            className="flex flex-col outline-none"
          >
            {sessions.data.data.map((session) => (
              <li
                key={session.id}
                className="flex items-center gap-4 not-first:border-t-hairline border-border-subtle px-6 py-3 max-narrow:px-4"
              >
                {/* Whole, never cut: the dates are what tell one browser's Sign out from another's. */}
                <span id={`device-${session.id}`} className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-2 text-label text-ink">
                    <span className="min-w-0 break-words">{nameOf(session)}</span>
                    {session.current && (
                      <span className="inline-flex h-badge items-center rounded-pill bg-surface-200 px-2 text-caption text-ink-muted">
                        {t('settings.devices.current')}
                      </span>
                    )}
                  </span>
                  <span className="text-caption text-ink-muted">
                    {t('settings.devices.signedIn', { when: format.absolute(session.createdAt) })}
                  </span>
                  {/* This one is in use now; its own last use says nothing. */}
                  {!session.current && (
                    <span className="text-caption text-ink-muted">
                      {t('settings.devices.lastUsed', {
                        when: format.absolute(session.lastUsedAt),
                      })}
                    </span>
                  )}
                </span>
                {!session.current && (
                  <Button
                    variant="dangerQuiet"
                    glyph="sign-out"
                    aria-describedby={`device-${session.id}`}
                    onClick={() => {
                      signOut(session);
                    }}
                  >
                    {t('user.signOut')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {others.length === 0 && (
            <p className="border-t-hairline border-border-subtle px-6 py-5 text-body text-ink-muted max-narrow:px-4">
              {t('settings.devices.none')}
            </p>
          )}
        </>
      )}
    </SettingsCard>
  );
};
