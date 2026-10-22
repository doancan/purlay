/**
 * A labelled text input, with its hint and its error wired to it.
 *
 * What goes wrong in a hand-built form field is silent: the label is not
 * associated (`htmlFor` points nowhere), the error is shown but not announced, or
 * the hint is read before the label. Here the label is a real `<label>`, the hint
 * and the error are both in `aria-describedby`, an error sets `aria-invalid`, and
 * the error is `role="alert"` so it is spoken when it appears — and it is text
 * with an icon, never only a red border (`UX.md` §9: never colour alone).
 *
 * The id is `useId`, so two fields on one page never share one.
 */
import { useId } from 'react';
import { Icon } from '../components/icon';
import { cn } from './cn';

/** A list longer than this gets a field to find in it; a shorter one is read at a glance. */
export const FINDABLE_FROM = 8;

const inputClasses =
  'h-control max-narrow:h-touch w-full rounded-md border-hairline bg-surface-100 px-3 text-body text-ink placeholder:text-ink-muted';

export interface TextFieldProps extends Omit<
  React.ComponentPropsWithRef<'input'>,
  'id' | 'aria-invalid' | 'aria-describedby'
> {
  readonly label: string;
  readonly hint?: string;
  /** Present only when the value is wrong; its presence is what marks the field invalid. */
  readonly error?: string;
  /**
   * Marked wrong with no message of its own: a sentence elsewhere says what is wrong with it (a failed
   * try names the field it concerns), so the field is outlined, announced as invalid, and says no more.
   */
  readonly invalid?: boolean;
}

export const TextField = ({
  label,
  hint,
  error,
  invalid = false,
  className,
  ...rest
}: TextFieldProps): React.JSX.Element => {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const wrong = error !== undefined || invalid;
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId]
    .filter((value) => value !== null)
    .join(' ');
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-ink">
        {label}
      </label>
      <input
        {...rest}
        id={id}
        aria-invalid={wrong ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        className={cn(inputClasses, wrong ? 'border-danger' : 'border-border-strong', className)}
      />
      {hint === undefined ? null : (
        <p id={hintId} className="text-caption text-ink-muted">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p
          id={errorId}
          role="alert"
          className="flex items-center gap-1 text-caption text-danger-text"
        >
          <Icon name="failed" size="sm" />
          {error}
        </p>
      )}
    </div>
  );
};
