/**
 * Signing in with an address, under GitHub on the sign-in card.
 *
 * **The password** is always offered (`withPassword`): the setup's administrator has one, on a server
 * with or without mail (R30). It is the library's route, answered in one sentence that never says whether
 * the address exists: a wrong address, a wrong password and an account with no password are the same
 * "wrong email or password". A wait is told in minutes, from `Retry-After`.
 *
 * **A link by email** (D-138) is offered only where the server can send mail — as the form's only action
 * on the sign-up screen, and as the second action under the password on the sign-in screen. The answer
 * is the same whatever the address (§1), so the screen says the same thing too: a link is on its way if
 * the address can use one. An invitation this tab holds rides in the link (§4), because the mail opens in
 * another tab, which has none; the invitation page's `beforeLink` asks for its passport first.
 */
import { SIGN_IN_LINK_TTL_MINUTES } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { isApiError, isLibraryFailure } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { TextField } from '../../ui/text-field';
import { browserInvitationPorts, pendingInvitation } from '../invitations/pending';

interface Failure {
  readonly field: 'email' | 'form';
  readonly message: string;
}

/** Whether a page's own errand before the link allows it to go on (`false`: it said why, stop). */
type BeforeLink = (email: string) => Promise<boolean>;

interface EmailSignInFormProps {
  /** No GitHub button above it: the form is the card's only way in, so it has no rule to hang from. */
  readonly alone?: boolean;
  /** The password field and Sign in; without it the form is the link's alone (the sign-up screen). */
  readonly withPassword?: boolean;
  /** What the invitation page does before a link is asked for: its passport for this address. */
  readonly beforeLink?: BeforeLink;
  /**
   * Whether this server can send a link, as the page's own read of `/api/auth/methods` says: asked once,
   * there, never again by a form that mounts under an answer that failed (it would ask by itself).
   */
  readonly mail: boolean;
}

const looksLikeAddress = (value: string): boolean => /^[^\s@]+@[^\s@]+$/.test(value);

export const EmailSignInForm = ({
  alone = false,
  withPassword = false,
  beforeLink,
  mail,
}: EmailSignInFormProps): React.JSX.Element | null => {
  const { t, locale } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'password' | 'link' | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Where focus goes when one view replaces the other: the sentence that was sent, or the field again.
  const said = useRef<HTMLParagraphElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [switched, setSwitched] = useState(false);
  useEffect(() => {
    if (!switched) return;
    if (sentTo === null) field.current?.focus();
    else said.current?.focus();
  }, [sentTo, switched]);

  // The link-only form (sign-up) is nothing without mail; the password form is never nothing.
  if (!withPassword && !mail) return null;
  // Under the GitHub button a rule parts the two ways in; with no button there is nothing to part.
  const ruled = alone ? '' : 'border-t-hairline border-border-subtle pt-6';

  if (sentTo !== null) {
    return (
      <section className={cn('flex w-full flex-col items-center gap-3', ruled)}>
        <p ref={said} tabIndex={-1} role="status" className="text-body text-ink">
          {t('signIn.email.sent', { email: sentTo, minutes: SIGN_IN_LINK_TTL_MINUTES })}
        </p>
        <Button
          variant="ghost"
          onClick={() => {
            setSentTo(null);
            setSwitched(true);
          }}
        >
          {t('signIn.email.another')}
        </Button>
      </section>
    );
  }

  const passwordFailure = (caught: unknown): string => {
    if (isLibraryFailure(caught)) {
      if (caught.status === 429) {
        return t('signIn.password.tooMany', {
          count: Math.max(1, Math.ceil((caught.retryAfter ?? 60) / 60)),
        });
      }
      if (caught.code === 'NETWORK') return t('signIn.password.unreachable');
      // One sentence for an address nobody has, a wrong password and a password the address has none
      // of; a shape the library would not read is no more telling.
      if (caught.status === 401 || caught.status === 400) return t('signIn.password.wrong');
    }
    return t('signIn.password.failed');
  };

  const signInWithPassword = async (): Promise<void> => {
    setBusy('password');
    setFailure(null);
    try {
      await api.signInWithPassword({ email: email.trim(), password });
      // The session is there now: the screen asks who it is, and a person who has one is sent on.
      await client.invalidateQueries({ queryKey: keys.me });
    } catch (caught) {
      setFailure({ field: 'form', message: passwordFailure(caught) });
      setBusy(null);
    }
  };

  const askForLink = async (): Promise<void> => {
    const address = email.trim();
    if (!looksLikeAddress(address)) {
      setFailure({ field: 'email', message: t('signIn.email.invalid') });
      field.current?.focus();
      return;
    }
    setBusy('link');
    setFailure(null);
    const invitation = pendingInvitation(browserInvitationPorts(), window.location);
    try {
      if (beforeLink !== undefined && !(await beforeLink(address))) {
        setBusy(null);
        return;
      }
      await api.requestEmailSignIn({
        email: address,
        locale,
        ...(invitation === null ? {} : { invitation }),
      });
      setSentTo(address);
      setSwitched(true);
    } catch (caught) {
      setFailure(
        isApiError(caught) && caught.code === 'VALIDATION_FAILED'
          ? { field: 'email', message: t('signIn.email.invalid') }
          : isApiError(caught) && caught.code === 'EMAIL_SIGN_IN_UNAVAILABLE'
            ? { field: 'form', message: t('signIn.email.unavailable') }
            : { field: 'form', message: `${t('signIn.email.failed')} ${describe(caught)}` },
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      aria-label={t(withPassword ? 'signIn.password.form' : 'signIn.email.label')}
      onSubmit={(event) => {
        event.preventDefault();
        void (withPassword ? signInWithPassword() : askForLink());
      }}
      className={cn('flex w-full flex-col gap-3 text-left', ruled)}
    >
      <TextField
        ref={field}
        label={t('signIn.email.label')}
        type="email"
        value={email}
        required
        maxLength={254}
        autoComplete={withPassword ? 'username' : 'email'}
        spellCheck={false}
        {...(failure?.field === 'email' ? { error: failure.message } : {})}
        onChange={(event) => {
          setEmail(event.target.value);
        }}
      />
      {withPassword && (
        <TextField
          label={t('signIn.password.label')}
          type="password"
          value={password}
          required
          maxLength={256}
          autoComplete="current-password"
          spellCheck={false}
          // The sentence below is about the pair, not about this field alone.
          invalid={failure?.field === 'form'}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      )}
      {failure?.field === 'form' && (
        <p role="alert" className="text-label text-danger-text">
          {failure.message}
        </p>
      )}
      {withPassword ? (
        <>
          <Button type="submit" variant="primary" busy={busy === 'password'} className="w-full">
            {t('signIn.password.submit')}
          </Button>
          {mail && (
            <Button
              variant="ghost"
              busy={busy === 'link'}
              className="w-full"
              onClick={() => {
                void askForLink();
              }}
            >
              {t('signIn.email.linkInstead')}
            </Button>
          )}
        </>
      ) : (
        <Button
          type="submit"
          variant={alone ? 'primary' : 'secondary'}
          busy={busy === 'link'}
          className="w-full"
        >
          {t('signIn.email.submit')}
        </Button>
      )}
    </form>
  );
};
