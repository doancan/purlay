/**
 * The account menu, from the sidebar's foot: who you are, and what is yours rather than the
 * workspace's (D-124) — Deep Work, the theme, the language, the shortcut reference, and signing out.
 *
 * - **Deep Work** is started for a while chosen here — half an hour, one, two, or until tomorrow
 *   morning — and the instant is what the server is sent, so it is the server's delivery that stops
 *   (D-15, D-108). On, it says until when and how long is left, and offers its end.
 * - **Sign out everywhere** ends every session the person holds, this one with them (D-11). It asks
 *   first, because it signs out devices that are not in front of them. Either sign-out forgets the
 *   page's cache and leaves with `replace`, so Back does not return to a page that would bounce; a
 *   refusal is a toast and the person stays signed in, and told.
 */
import { useState } from 'react';
import { Icon } from '../../components/icon';
import { useActions } from '../../data/actions-provider';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../../ui/menu';
import { useToast } from '../../ui/toast';
import { useSession } from '../session/session';
import { DEEP_WORK_CHOICES, useDeepWorkControls } from './deep-work';
import { PreferenceItems } from './settings-menu';

/** Deep Work's part of the menu: the whiles to start it for, or how long is left and its end. */
const DeepWorkItems = (): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const deepWork = useDeepWorkControls();
  if (deepWork === null) return null;
  const { until } = deepWork;
  return (
    <>
      <MenuLabel>
        {until === null
          ? t('deepWork.label')
          : t('deepWork.left', { until: format.absolute(until), count: deepWork.minutesLeft() })}
      </MenuLabel>
      {until === null ? (
        DEEP_WORK_CHOICES.map((choice) => (
          <MenuItem
            key={choice}
            glyph="deep-work"
            onSelect={() => {
              deepWork.start(choice);
            }}
          >
            {t(`deepWork.choice.${choice}`)}
          </MenuItem>
        ))
      ) : (
        <MenuItem glyph="deep-work" onSelect={deepWork.end}>
          {t('deepWork.stop')}
        </MenuItem>
      )}
      <MenuSeparator />
    </>
  );
};

export const AccountMenu = (): React.JSX.Element => {
  const { t } = useI18n();
  const { user } = useSession();
  const { signOut } = useActions();
  const { navigate } = useRoute();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const [confirming, setConfirming] = useState(false);

  const leave = (scope: 'here' | 'everywhere'): void => {
    // A refused sign-out leaves the person signed in and says so; going to the sign-in screen
    // anyway would bounce straight back and look like nothing happened.
    void signOut(scope).then(
      () => {
        navigate(href('signIn'), { replace: true });
      },
      (error: unknown) => {
        show({ message: `${t('failure.signOut')} ${describe(error)}` });
      },
    );
  };

  return (
    <>
      <Menu
        side="top"
        align="start"
        trigger={
          <button
            type="button"
            aria-label={t('user.menuFor', { name: user.displayName })}
            className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors duration-hover ease-standard hover:bg-nav-hover"
          >
            <Avatar size="md" name={user.displayName} username={user.username} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label font-semibold text-nav-ink">
                {user.displayName}
              </span>
              <span className="block truncate font-mono text-caption text-nav-ink-muted">
                {`@${user.username}`}
              </span>
            </span>
            <span className="text-nav-ink-muted">
              <Icon name="preferences" />
            </span>
          </button>
        }
      >
        <DeepWorkItems />
        <PreferenceItems />
        <MenuSeparator />
        <MenuItem
          glyph="sign-out"
          onSelect={() => {
            leave('here');
          }}
        >
          {t('user.signOut')}
        </MenuItem>
        <MenuItem
          glyph="sign-out"
          tone="danger"
          onSelect={() => {
            setConfirming(true);
          }}
        >
          {t('user.signOutEverywhere.entry')}
        </MenuItem>
      </Menu>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('user.signOutEverywhere.title')}
        description={t('user.signOutEverywhere.body')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              glyph="sign-out"
              onClick={() => {
                setConfirming(false);
                leave('everywhere');
              }}
            >
              {t('user.signOutEverywhere')}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </>
  );
};
