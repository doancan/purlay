/**
 * The pieces every step is made of: its heading, the three-part failure, a value to copy, a note.
 * Layout and semantics only; the sentences are the step's.
 */
import type { ProbeResult } from '@purlay/types';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import type { PlainKey } from '../../i18n/types';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { TextField } from '../../ui/text-field';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { isSetupFailure } from './client';
import { failureWords, reasonWords } from './errors';
import { movementClass, useReducedMotion } from './motion';

/**
 * A step can show itself in more than one state — a form, then "connected", then "sent". The step's
 * arrival moves focus to its heading (`setup-screen.tsx`); a state reached inside it does the same,
 * or a keyboard or screen-reader user is left on a button that is no longer there. Not on the first
 * render: that is the page opening, or the arrival the screen already handled.
 */
export const useHeadingFocusOnChange = (state: string): void => {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.querySelector<HTMLElement>('[data-step-heading]')?.focus();
  }, [state]);
};

/** A step's title and the sentence under it. The heading takes focus when the step arrives. */
export const StepHeader = ({
  title,
  lede,
}: {
  readonly title: string;
  readonly lede: string;
}): React.JSX.Element => (
  <header className="flex flex-col gap-2">
    <h1 tabIndex={-1} data-step-heading className="text-display outline-none">
      {title}
    </h1>
    <p className="max-w-dialog text-pretty text-body text-ink-muted">{lede}</p>
  </header>
);

/** The buttons under a step: what goes back on the left, what goes on at the right. */
export const Actions = ({
  start,
  children,
}: {
  readonly start?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <div className="flex max-w-dialog flex-wrap items-center justify-between gap-3 pt-2">
    <div className="flex items-center gap-2">{start}</div>
    <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
  </div>
);

/** A sentence the page says about what was done: a tick and the words. */
export const Note = ({
  tone = 'info',
  children,
}: {
  readonly tone?: 'info' | 'good' | 'warn';
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <p
    role={tone === 'info' ? undefined : 'status'}
    className={cn(
      'flex items-start gap-2 rounded-md border-hairline px-3 py-2 text-label font-normal',
      tone === 'good' && 'border-success bg-success-subtle text-success-text',
      tone === 'warn' && 'border-warning bg-warning-subtle text-warning-text',
      tone === 'info' && 'border-border-subtle bg-surface-050 text-ink-muted',
    )}
  >
    <span className="flex h-5 items-center">
      <Icon name={tone === 'good' ? 'resolved' : tone === 'warn' ? 'warning' : 'info'} size="md" />
    </span>
    <span className="min-w-0 text-pretty">{children}</span>
  </p>
);

/**
 * A failed try, in the three parts the wizard always gives: what happened under a red heading, how to
 * put it right as a short list, and what the service answered — **as text**: the reply is another
 * party's words and is never read as markup.
 */
export const ProbeFailure = ({
  result,
  channel,
}: {
  readonly result: Extract<ProbeResult, { ok: false }>;
  /** Whose try it was, where its words differ from GitHub's and the mail server's (D-200). */
  readonly channel?: 'oidc';
}): React.JSX.Element => {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const words = reasonWords(result.reason, channel);
  return (
    <section
      role="alert"
      aria-label={t('setup.failure.what')}
      className={cn(
        'flex flex-col gap-3 rounded-md border-hairline border-danger bg-danger-subtle p-4',
        movementClass('nudge', reduced),
      )}
    >
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 text-label text-danger-text">
          <Icon name="failed" size="md" />
          {t('setup.failure.what')}
        </h3>
        <p className="text-body text-ink">{t(words.what)}</p>
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-label text-ink">{t('setup.failure.fix')}</h3>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-body text-ink-muted">
          {words.fix.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
      </div>
      {result.raw !== '' && (
        <div className="flex flex-col gap-1">
          <h3 className="text-label text-ink">{t('setup.failure.raw')}</h3>
          <pre className="whitespace-pre-wrap break-words rounded-md border-hairline border-border-subtle bg-surface-100 px-3 py-2 font-mono text-caption text-ink">
            {result.raw}
          </pre>
        </div>
      )}
    </section>
  );
};

/** A call that failed outright (not a try that was answered): one sentence, and a minute count if asked. */
export const FailureNote = ({
  failure,
  lead,
}: {
  readonly failure: unknown;
  readonly lead?: PlainKey;
}): React.JSX.Element => {
  const { t } = useI18n();
  const words = isSetupFailure(failure)
    ? failureWords(failure)
    : ({ kind: 'plain', key: 'setup.failed.generic' } as const);
  return (
    <p role="alert" className="flex items-start gap-2 text-label text-danger-text">
      <span className="flex h-5 items-center">
        <Icon name="failed" size="md" />
      </span>
      <span className="text-pretty">
        {lead === undefined ? '' : `${t(lead)} `}
        {words.kind === 'rate' ? t('setup.failed.rate', { count: words.minutes }) : t(words.key)}
      </span>
    </p>
  );
};

/**
 * A value to copy, shown whole — an address or a command wraps rather than being cut at the field's
 * edge, since it is the one thing the person must get exactly right — with Copy beside it.
 */
export const CopyField = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  };
  return (
    <div className="flex w-full items-start gap-2">
      <p className="min-w-0 flex-1 rounded-md border-hairline border-border-subtle bg-surface-050 px-3 py-2">
        <VisuallyHidden>{label}: </VisuallyHidden>
        <code className="select-all break-all font-mono text-caption text-ink">{value}</code>
      </p>
      <Button variant="secondary" glyph={copied ? 'confirm' : 'copy'} onClick={copy}>
        {copied ? t('common.copied') : t('common.copy')}
      </Button>
    </div>
  );
};

/**
 * The mail server's address, which carries the account's password (`smtp://user:password@host`): masked
 * like a password, with the reveal toggle the administrator's password has, so a screen shared over a
 * shoulder or a recording does not show it.
 */
export const MailServerField = ({
  value,
  invalid,
  error,
  onChange,
}: {
  readonly value: string;
  readonly invalid: boolean;
  /** The server's refusal of the address itself, said under the field. */
  readonly error?: string;
  readonly onChange: (value: string) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [reveal, setReveal] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <TextField
          label={t('setup.email.url')}
          hint={t('setup.email.urlHint')}
          type={reveal ? 'text' : 'password'}
          value={value}
          autoComplete="off"
          spellCheck={false}
          maxLength={2048}
          className="font-mono"
          invalid={invalid}
          {...(error === undefined ? {} : { error })}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      </div>
      <Button
        variant="ghost"
        className="mt-6 shrink-0"
        aria-pressed={reveal}
        aria-label={reveal ? t('setup.email.hideLabel') : t('setup.email.showLabel')}
        onClick={() => {
          setReveal((now) => !now);
        }}
      >
        {reveal ? t('setup.admin.hide') : t('setup.admin.show')}
      </Button>
    </div>
  );
};
