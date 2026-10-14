/**
 * The person on the other side of a conversation (#488, D-131), in the panel beside it: their name
 * and handle, their title, their status line, and the time it is where they are, with the zone.
 * Read from the workspace's members, which carry every profile and are read again when one changes.
 */
import type { User } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { PanelFrame, StaleBanner, usePanelFocus } from '../channel/panel-frame';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { useSidePanel } from '../channel/side-panel';
import { useLocalTime, useMember } from './local-time';
import { useOnline } from '../../realtime/realtime-provider';
import { useSession } from '../session/session';

export const PROFILE_PANEL_ID = 'conversation-profile';

const ProfilePanelView = ({ person }: { readonly person: User }): React.JSX.Element => {
  const { t } = useI18n();
  const { member, members } = useMember(person.id);
  const { user: me } = useSession();
  const online = useOnline(person.id, me.id);
  const focus = usePanelFocus(
    members.isFetching,
    Math.max(members.dataUpdatedAt, members.errorUpdatedAt),
  );
  const profile = member?.profile;
  const time = useLocalTime(profile);
  const empty =
    profile !== undefined && (profile.title ?? profile.status ?? profile.timeZone) === null;
  const readAgain = (): void => {
    focus.answering();
    void members.refetch();
  };
  return (
    <PanelFrame
      id={PROFILE_PANEL_ID}
      title={t('profile.panel')}
      channelLabel={person.displayName}
      closeLabel={t('profile.close')}
      focus={focus}
    >
      {members.isRefetchError && (
        <StaleBanner message={t('profile.staleFailed')} onRetry={readAgain} />
      )}
      <section className="flex flex-col items-start gap-3 p-4">
        <Avatar name={person.displayName} username={person.username} size="lg" online={online} />
        <div className="flex flex-col gap-1">
          <p className="text-title font-semibold text-ink">{person.displayName}</p>
          <p className="font-mono text-label text-ink-muted">{`@${person.username}`}</p>
          {/* Said in words, beside the dot: never a colour alone (D-136). */}
          {online === true && <p className="text-label text-ink">{t('presence.onlineNow')}</p>}
        </div>
        {members.isPending ? (
          <LoadingStatus label={t('profile.loading')} className="flex w-full flex-col gap-2">
            <Skeleton className="w-members" />
            <Skeleton className="w-sidebar" />
          </LoadingStatus>
        ) : members.isError && members.data === undefined ? (
          <div role="alert" className="flex items-center gap-2 text-label text-danger-text">
            {t('profile.failed')}
            <span aria-hidden="true">·</span>
            <button type="button" className="underline" onClick={readAgain}>
              {t('common.retry')}
            </button>
          </div>
        ) : (
          <>
            {profile?.title != null && <p className="text-body text-ink">{profile.title}</p>}
            {profile?.status != null && (
              <p className="whitespace-pre-wrap break-words text-body text-ink-muted">
                {profile.status}
              </p>
            )}
            {profile?.timeZone != null && (
              <div className="flex flex-col gap-1 text-label">
                {time !== null && <p className="text-ink">{t('profile.localTime', { time })}</p>}
                <p className="text-ink-muted">
                  {`${t('profile.zone')} · `}
                  <span className="font-mono text-ink">{profile.timeZone}</span>
                </p>
              </div>
            )}
            {(empty || member === undefined) && (
              <p className="text-body text-ink-muted">{t('profile.noProfile')}</p>
            )}
          </>
        )}
      </section>
    </PanelFrame>
  );
};

/** The profile panel of a conversation with one other person, when it is the one open. */
export const ProfilePanel = ({
  person,
}: {
  readonly person: User | null;
}): React.JSX.Element | null => {
  const { panel } = useSidePanel();
  return panel === 'profile' && person !== null ? <ProfilePanelView person={person} /> : null;
};
