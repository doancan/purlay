/**
 * Signing in by email (D-138), under GitHub on the sign-in card — only where the server can send mail;
 * elsewhere, or until it has said, the card is GitHub's alone, which always works.
 *
 * The answer is the same whatever the address (§1), so the screen says the same thing too: a link is
 * on its way if the address can use one. An invitation this tab holds rides in the link (§4), because
 * the mail opens in another tab, which has none.
 */
import { useQuery } from '@tanstack/react-query';
import { SIGN_IN_LINK_TTL_MINUTES } from '@purlay/types';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { TextField } from '../../ui/text-field';
import { browserInvitationPorts, pendingInvitation } from '../invitations/pending';

interface Failure {
  readonly field: 'email' | 'form';
  readonly message: string;
}

export const EmailSignInForm = (): React.JSX.Element | null => {
  const { t, locale } = useI18n();
  const api = useApi();
  const describe = useDescribeFailure();
  const methods = useQuery({
    queryKey: keys.authMethods,
    queryFn: async ({ signal }) => await api.authMethods(signal),
  });
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
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

  if (methods.data?.email !== true) return null;

  if (sentTo !== null) {
    return (
      <section className="flex w-full flex-col items-center gap-3 border-t-hairline border-border-subtle pt-6">
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

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    const invitation = pendingInvitation(browserInvitationPorts(), window.location);
    try {
      await api.requestEmailSignIn({
        email: email.trim(),
        locale,
        ...(invitation === null ? {} : { invitation }),
      });
      setSentTo(email.trim());
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
      setBusy(false);
    }
  };

  return (
    <form
      aria-label={t('signIn.email.label')}
      onSubmit={(event) => {
        void submit(event);
      }}
      className="flex w-full flex-col gap-3 border-t-hairline border-border-subtle pt-6 text-left"
    >
      <TextField
        ref={field}
        label={t('signIn.email.label')}
        type="email"
        value={email}
        required
        maxLength={254}
        autoComplete="email"
        spellCheck={false}
        {...(failure?.field === 'email' ? { error: failure.message } : {})}
        onChange={(event) => {
          setEmail(event.target.value);
        }}
      />
      {failure?.field === 'form' && (
        <p role="alert" className="text-label text-danger-text">
          {failure.message}
        </p>
      )}
      <Button type="submit" variant="secondary" busy={busy} className="w-full">
        {t('signIn.email.submit')}
      </Button>
    </form>
  );
};
