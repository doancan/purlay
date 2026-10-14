/**
 * A conversation with one other person, headed by them (#488, D-131): their name, which opens their
 * profile beside the conversation, the time it is where they are, and their status line — so a
 * message is not sent at three in their morning without knowing it.
 */
import type { User } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { useSidePanel } from '../channel/side-panel';
import { useLocalTime, useMember } from './local-time';
import { PROFILE_PANEL_ID } from './profile-panel';

export const PeerHeading = ({
  peer,
  title,
}: {
  readonly peer: User;
  readonly title: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const side = useSidePanel();
  const profile = useMember(peer.id)?.profile;
  const time = useLocalTime(profile);
  const open = side.panel === 'profile';
  return (
    <>
      <h1 className="min-w-0 shrink-0 truncate text-title text-ink">
        <button
          type="button"
          data-panel-toggle="profile"
          aria-label={t('profile.open', { name: peer.displayName })}
          aria-expanded={open}
          aria-controls={open ? PROFILE_PANEL_ID : undefined}
          className="max-w-full truncate rounded-sm hover:text-accent-text"
          onClick={() => {
            if (open) side.close();
            else side.open('profile');
          }}
        >
          {title}
        </button>
      </h1>
      {time !== null && (
        <span className="shrink-0 font-mono text-caption text-ink-muted max-narrow:hidden">
          {t('profile.localTime', { time })}
        </span>
      )}
      {profile?.status != null && (
        <span className="min-w-0 truncate text-label text-ink-muted max-narrow:hidden">
          {profile.status}
        </span>
      )}
    </>
  );
};
