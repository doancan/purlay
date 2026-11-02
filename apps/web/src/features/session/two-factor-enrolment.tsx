/**
 * What a person the server holds back sees instead of the application (D-239, `UX.md` §11): their account signs
 * in with a password, the server requires two-step verification of such an account, and theirs is off. Every
 * other route answers `403 TWO_FACTOR_REQUIRED` until it is on, so nothing else is drawn — no shell, no socket —
 * only the card that turns it on and a way to sign out.
 *
 * The card is Sessions & account's own, with nothing to turn off. Turned on, the backup codes are shown once;
 * only when the person has pressed Done is the identity read again, and the gate then lets the application
 * draw — on the same session, with no sign-in again.
 */
import { useQueryClient } from '@tanstack/react-query';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Main } from '../../ui/main';
import { TwoFactorCard } from '../settings/pages/two-factor-card';
import { LogoMark } from '../shell/notice';
import { useSignOut } from '../shell/sign-out';

export const TwoFactorEnrolment = ({
  email,
}: {
  /** The account's address, for a password manager to file the password under. */
  readonly email: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const client = useQueryClient();
  const signOut = useSignOut();
  return (
    <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-4 text-ink">
      <section
        aria-labelledby="two-factor-enrolment-title"
        className="flex w-full max-w-dialog flex-col gap-6"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <LogoMark />
          <h1 id="two-factor-enrolment-title" className="text-display">
            {t('enrolTwoFactor.title')}
          </h1>
          <p className="text-balance text-body text-ink-muted">{t('enrolTwoFactor.lede')}</p>
        </div>
        <TwoFactorCard
          email={email}
          enabled={false}
          required
          onTurnedOn={() => {
            void client.invalidateQueries({ queryKey: keys.me });
            void client.invalidateQueries({ queryKey: keys.mySignIn });
          }}
        />
        <div className="flex justify-center">
          <Button
            variant="ghost"
            onClick={() => {
              signOut('here');
            }}
          >
            {t('enrolTwoFactor.signOut')}
          </Button>
        </div>
      </section>
    </Main>
  );
};
