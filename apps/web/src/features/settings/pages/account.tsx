/**
 * Sessions & account (D-146): leaving, and ending the account.
 *
 * *Sign out everywhere* ends every session the person holds, this one with them (D-11); it asks first,
 * because it signs out devices that are not in front of them. *Erase my account* is the dialog it has
 * always been (D-139 §5) — typing the username is the confirmation — opened from a card drawn in the
 * danger tone, so what cannot be undone looks it and sits apart from what can.
 */
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { EraseAccountDialog } from '../../shell/erase-account-dialog';
import { useSignOut } from '../../shell/sign-out';
import { SettingsCard, SettingsPage, SettingsRow } from '../page';

export const AccountPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const leave = useSignOut();
  const [confirming, setConfirming] = useState(false);
  const [erasing, setErasing] = useState(false);
  return (
    <SettingsPage
      title={t('settings.account.title')}
      description={t('settings.account.description')}
    >
      <SettingsCard title={t('settings.account.sessions')}>
        <SettingsRow
          label={t('settings.account.here')}
          description={t('settings.account.hereHint')}
        >
          <Button
            glyph="sign-out"
            onClick={() => {
              leave('here');
            }}
          >
            {t('user.signOut')}
          </Button>
        </SettingsRow>
        <SettingsRow
          label={t('user.signOutEverywhere')}
          description={t('user.signOutEverywhere.body')}
        >
          <Button
            glyph="sign-out"
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t('user.signOutEverywhere.entry')}
          </Button>
        </SettingsRow>
      </SettingsCard>
      <SettingsCard title={t('settings.account.danger')} tone="danger">
        <SettingsRow label={t('erase.title')} description={t('settings.account.eraseHint')}>
          <Button
            variant="dangerQuiet"
            glyph="delete"
            onClick={() => {
              setErasing(true);
            }}
          >
            {t('erase.entry')}
          </Button>
        </SettingsRow>
      </SettingsCard>
      <EraseAccountDialog
        open={erasing}
        onOpenChange={setErasing}
        onSignOut={() => {
          leave('here');
        }}
      />
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
    </SettingsPage>
  );
};
