/**
 * `/mail/stop#<token>` — the link at the end of a missed-mail letter (D-240). Public, in any browser, signed in
 * or not: the token is the proof, and it stops the letters of the person it was sent to. The token leaves the
 * address bar as the page reads it, as a sign-in link's does, and nothing is spent on load: a mail scanner
 * that opens the page stops nothing, the person presses the button.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { Button, buttonStyle } from '../../ui/button';
import { Main } from '../../ui/main';
import { browserInvitationPorts } from '../invitations/pending';
import { LogoMark, Notice } from '../shell/notice';

const FRAGMENT = /^#([0-9a-f]{64})$/;

/** The link's token, or nothing for a fragment that is not one. */
export const readStopLink = (hash: string): string | null => FRAGMENT.exec(hash)?.[1] ?? null;

const Card = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-4 text-ink">
    <div className="flex w-full max-w-dialog flex-col items-center gap-4 rounded-2xl border-hairline border-border-subtle bg-surface-100 p-8 text-center shadow-card">
      <LogoMark />
      {children}
    </div>
  </Main>
);

type State =
  | { readonly kind: 'asking' | 'stopping' | 'stopped' | 'refused' }
  | { readonly kind: 'failed'; readonly words: string };

export const MailStopScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const describe = useDescribeFailure();
  const [token] = useState(() => readStopLink(window.location.hash));
  const [state, setState] = useState<State>({ kind: 'asking' });
  const ports = useMemo(browserInvitationPorts, []);
  const heading = useRef<HTMLDivElement>(null);

  // The secret leaves the address bar, the history and any screen being shared.
  useEffect(() => {
    if (window.location.hash !== '') ports.replace(href('mailStop'));
  }, [ports]);
  // An answer replaces the question: focus goes with it, so a screen reader hears it.
  useEffect(() => {
    if (state.kind !== 'asking' && state.kind !== 'stopping') heading.current?.focus();
  }, [state.kind]);

  const open = (
    <a href={href('home')} className={buttonStyle('primary', 'lg')}>
      {t('mailStop.open')}
    </a>
  );

  if (token === null) {
    return (
      <Card>
        <Notice
          as="h1"
          glyph="warning"
          title={t('mailStop.missing.title')}
          body={t('mailStop.missing.body')}
          action={open}
        />
      </Card>
    );
  }

  const stop = async (): Promise<void> => {
    setState({ kind: 'stopping' });
    try {
      await api.stopMissedMail(token);
      setState({ kind: 'stopped' });
    } catch (failure) {
      setState(
        isApiError(failure) && failure.code === 'MAIL_LINK_NOT_FOUND'
          ? { kind: 'refused' }
          : { kind: 'failed', words: `${t('mailStop.failed')} ${describe(failure)}` },
      );
    }
  };

  const answer =
    state.kind === 'stopped' ? (
      <Notice
        as="h1"
        glyph="resolved"
        title={t('mailStop.done.title')}
        body={t('mailStop.done.body')}
        action={open}
      />
    ) : state.kind === 'refused' ? (
      <Notice
        as="h1"
        glyph="warning"
        title={t('mailStop.refused.title')}
        body={t('mailStop.refused.body')}
        action={open}
      />
    ) : null;

  return (
    <Card>
      {answer === null ? (
        <Notice
          as="h1"
          glyph="notifications"
          title={t('mailStop.title')}
          body={state.kind === 'failed' ? state.words : t('mailStop.body')}
          action={
            <Button
              variant="primary"
              busy={state.kind === 'stopping'}
              onClick={() => {
                void stop();
              }}
            >
              {t('mailStop.action')}
            </Button>
          }
        />
      ) : (
        <div ref={heading} tabIndex={-1} className="outline-none">
          {answer}
        </div>
      )}
    </Card>
  );
};
