/**
 * The person on the other side of a conversation (#488, D-131), in the panel beside it: their name
 * and handle, their title, their status line, and the time it is where they are, with the zone.
 * Read from the workspace's members, which carry every profile and are read again when one changes.
 */
import type { User } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { PanelFrame, usePanelFocus } from '../channel/panel-frame';
import { useSidePanel } from '../channel/side-panel';
import { useLocalTime, useMember } from './local-time';

export const PROFILE_PANEL_ID = 'conversation-profile';

const ProfilePanelView = ({ person }: { readonly person: User }): React.JSX.Element => {
  const { t } = useI18n();
  const focus = usePanelFocus(false, 0);
  const profile = useMember(person.id)?.profile;
  const time = useLocalTime(profile);
  const empty =
    profile === undefined || (profile.title ?? profile.status ?? profile.timeZone) === null;
  return (
    <PanelFrame
      id={PROFILE_PANEL_ID}
      title={t('profile.panel')}
      channelLabel={person.displayName}
      closeLabel={t('profile.close')}
      focus={focus}
    >
      <section className="flex flex-col items-start gap-3 p-4">
        <Avatar name={person.displayName} username={person.username} size="lg" />
        <div className="flex flex-col gap-1">
          <p className="text-title font-semibold text-ink">{person.displayName}</p>
          <p className="font-mono text-label text-ink-muted">{`@${person.username}`}</p>
        </div>
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
        {empty && <p className="text-body text-ink-muted">{t('profile.noProfile')}</p>}
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
