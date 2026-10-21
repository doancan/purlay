/**
 * The shape every settings page shares (D-146): a title and one sentence, then cards; inside a card,
 * rows with a label and a sentence on the left and the control on the right.
 *
 * One shape so the pages read alike and so a page cannot drift into a layout of its own: the column
 * width, the ground under the cards, the gap between them and the rows' padding are decided here and
 * nowhere else. The column is the main area's full width, from its left edge (D-177), on `surface-000`; a card is `surface-100`
 * with a hairline and the card shadow, so in both themes the card is a step above its ground.
 *
 * Below the narrow breakpoint a row stacks — label, then a full-width control — because a label and a
 * 320px field do not fit beside each other in 390px.
 */
import { useId } from 'react';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { NavToggle } from '../shell/nav';

interface SettingsPageProps {
  readonly title: string;
  readonly description: string;
  /** Beside the title: a page's one primary action (Invite people on Members). */
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}

export const SettingsPage = ({
  title,
  description,
  action,
  children,
}: SettingsPageProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <>
      {/* Narrow, the settings' navigation is in the overlay: this bar is the way to it. */}
      <header className="hidden h-header shrink-0 items-center gap-3 border-b-hairline border-border-subtle bg-surface-100 pr-4 pl-5 max-narrow:flex">
        <NavToggle />
        <span className="text-heading text-ink">{t('settings.title')}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface-000">
        <div className="flex w-full flex-col gap-8 px-10 pt-10 pb-16 max-narrow:px-4 max-narrow:pt-6 max-narrow:pb-10">
          <header className="flex items-start justify-between gap-6 max-narrow:flex-col max-narrow:gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="text-display text-ink">{title}</h1>
              <p className="text-body text-ink-muted">{description}</p>
            </div>
            {action !== undefined && <div className="shrink-0">{action}</div>}
          </header>
          {children}
        </div>
      </div>
    </>
  );
};

interface SettingsCardProps {
  readonly title?: string;
  readonly description?: string;
  /** Right of the card's heading: a filter, a count, a secondary action. */
  readonly actions?: React.ReactNode;
  /** Under the rows, right-aligned: Save, and what became of the last save, to its left. */
  readonly footer?: React.ReactNode;
  /** The danger zone: the edge in the danger tone, so what is irreversible looks it. */
  readonly tone?: 'default' | 'danger';
  readonly children: React.ReactNode;
}

export const SettingsCard = ({
  title,
  description,
  actions,
  footer,
  tone = 'default',
  children,
}: SettingsCardProps): React.JSX.Element => {
  const headingId = useId();
  return (
    <section
      {...(title === undefined ? {} : { 'aria-labelledby': headingId })}
      className={cn(
        'overflow-hidden rounded-xl border-hairline bg-surface-100 shadow-card',
        tone === 'danger' ? 'border-danger' : 'border-border-subtle',
      )}
    >
      {title !== undefined && (
        <header className="flex items-start justify-between gap-4 border-b-hairline border-border-subtle px-6 py-4 max-narrow:px-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2
              id={headingId}
              className={cn('text-heading', tone === 'danger' ? 'text-danger-text' : 'text-ink')}
            >
              {title}
            </h2>
            {description !== undefined && (
              <p className="text-label font-normal text-ink-muted">{description}</p>
            )}
          </div>
          {actions !== undefined && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className="flex flex-col">{children}</div>
      {footer !== undefined && (
        <footer className="flex items-center justify-end gap-3 border-t-hairline border-border-subtle bg-surface-050 px-6 py-3 max-narrow:px-4">
          {footer}
        </footer>
      )}
    </section>
  );
};

interface SettingsRowProps {
  readonly label: string;
  readonly description?: string;
  /** The control's id, when the label names a single field; otherwise the label is plain text. */
  readonly htmlFor?: string;
  /** A control wider than a field (a set of choices): it takes the row's width under the label. */
  readonly wide?: boolean;
  /** A field or a select: the control column is a field's width, so fields line up row to row. */
  readonly fill?: boolean;
  readonly children: React.ReactNode;
}

export const SettingsRow = ({
  label,
  description,
  htmlFor,
  wide = false,
  fill = false,
  children,
}: SettingsRowProps): React.JSX.Element => (
  <div
    className={cn(
      'flex not-first:border-t-hairline border-border-subtle px-6 py-5 max-narrow:flex-col max-narrow:gap-3 max-narrow:px-4 max-narrow:py-4',
      wide
        ? 'flex-col gap-3'
        : // A label alone is centred on the control beside it; with a description it hangs from the top.
          cn(
            'justify-between gap-6',
            description === undefined ? 'items-center max-narrow:items-start' : 'items-start',
          ),
    )}
  >
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {htmlFor === undefined ? (
        <span className="text-label text-ink">{label}</span>
      ) : (
        <label htmlFor={htmlFor} className="text-label text-ink">
          {label}
        </label>
      )}
      {description !== undefined && (
        <p className="text-label font-normal text-ink-muted">{description}</p>
      )}
    </div>
    <div
      className={cn(
        'flex min-w-0 items-center gap-2',
        wide
          ? 'w-full'
          : fill
            ? 'w-full max-w-field shrink-0 max-narrow:max-w-none'
            : 'shrink-0 justify-end max-narrow:justify-start',
      )}
    >
      {children}
    </div>
  </div>
);

/** The words beside a card's Save: what became of the last save, quiet when it went well. */
export const SaveOutcome = ({
  outcome,
}: {
  readonly outcome: { readonly ok: boolean; readonly words: string } | null;
}): React.JSX.Element | null =>
  outcome === null ? null : (
    <p
      role={outcome.ok ? 'status' : 'alert'}
      className={cn(
        'mr-auto text-label font-normal',
        outcome.ok ? 'text-ink-muted' : 'text-danger-text',
      )}
    >
      {outcome.words}
    </p>
  );

interface SettingsTextRowProps extends Omit<
  React.ComponentPropsWithRef<'input'>,
  'id' | 'aria-invalid' | 'aria-describedby'
> {
  readonly label: string;
  readonly hint?: string;
  /** Present only when the value is wrong; its presence is what marks the field invalid. */
  readonly error?: string;
  /** Under the field, beside it: a one-press fill such as "Use this device's time zone". */
  readonly after?: React.ReactNode;
}

/**
 * A text field as a settings row: the label and hint on the left, the field on the right. The same
 * wiring as `TextField` (`ui/text-field.tsx`) — a real label, the hint and the error in
 * `aria-describedby`, the error announced and drawn with an icon, never by colour alone.
 */
export const SettingsTextRow = ({
  label,
  hint,
  error,
  after,
  className,
  ...rest
}: SettingsTextRowProps): React.JSX.Element => {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId]
    .filter((value) => value !== null)
    .join(' ');
  return (
    <div className="flex items-start justify-between gap-6 not-first:border-t-hairline border-border-subtle px-6 py-5 max-narrow:flex-col max-narrow:gap-3 max-narrow:px-4 max-narrow:py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor={id} className="text-label text-ink">
          {label}
        </label>
        {hint !== undefined && (
          <p id={hintId} className="text-label font-normal text-ink-muted">
            {hint}
          </p>
        )}
      </div>
      <div className="flex w-full max-w-field shrink-0 flex-col items-start gap-2 max-narrow:max-w-none">
        <input
          {...rest}
          id={id}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          className={cn(
            'h-control w-full rounded-md border-hairline bg-surface-100 px-3 text-body text-ink placeholder:text-ink-muted max-narrow:h-touch',
            error === undefined ? 'border-border-strong' : 'border-danger',
            className,
          )}
        />
        {error !== undefined && (
          <p
            id={errorId}
            role="alert"
            className="flex items-center gap-1 text-caption text-danger-text"
          >
            <Icon name="failed" size="sm" />
            {error}
          </p>
        )}
        {after}
      </div>
    </div>
  );
};
