/**
 * A date field (D-247): a button that says the day in the person's language and opens a month to pick it from.
 *
 * The browser's own `<input type="date">` is three spinning segments, a picker that looks different in
 * every browser, and no way to clear it from the keyboard. This one is a labelled button (the field's
 * edge, height and type, like `TextField`) and a popover grid that is a real keyboard widget: arrows
 * move a day or a week, PageUp/PageDown a month, Home/End the week's ends, Enter or Space picks, Escape
 * closes and returns to the button. A day outside `min`/`max` is disabled, not hidden. The value is
 * `YYYY-MM-DD` or `''`, exactly what the input held, so callers change only the element.
 */
import * as Popover from '@radix-ui/react-popover';
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../components/icon';
import { useI18n } from '../i18n/i18n-provider';
import { addDays, addMonths, isDay, monthGrid, monthOf } from './calendar-month';
import { systemClock } from '../system-clock';
import { cn } from './cn';

export interface DateFieldProps {
  readonly label: string;
  /** `YYYY-MM-DD`, or empty for no day. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly min?: string;
  readonly max?: string;
  readonly hint?: string;
  readonly error?: string;
}

const dayCell =
  'flex size-control items-center justify-center rounded-md text-label tabular-nums transition-colors duration-hover ease-standard disabled:cursor-not-allowed disabled:text-ink-muted max-narrow:size-touch';

export const DateField = ({
  label,
  value,
  onChange,
  min,
  max,
  hint,
  error,
}: DateFieldProps): React.JSX.Element => {
  const { locale, t, format } = useI18n();
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const today = format.isoDay(systemClock.now());
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(today);
  const gridRef = useRef<HTMLDivElement>(null);
  // Set when the keyboard moved the day: only then does focus follow it into the grid.
  const followFocus = useRef(false);

  useEffect(() => {
    if (!open || !followFocus.current) return;
    followFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focused}"]`)?.focus();
  }, [open, focused]);

  const dayName = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' });
  const monthName = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const asUtc = (day: string): Date => new Date(`${day}T00:00:00Z`);
  const allowed = (day: string): boolean =>
    (min === undefined || day >= min) && (max === undefined || day <= max);

  const choose = (day: string): void => {
    if (!allowed(day)) return;
    onChange(day);
    setOpen(false);
  };

  const move = (day: string): void => {
    if (!isDay(day)) return;
    followFocus.current = true;
    setFocused(day);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const steps: Record<string, string> = {
      ArrowLeft: addDays(focused, -1),
      ArrowRight: addDays(focused, 1),
      ArrowUp: addDays(focused, -7),
      ArrowDown: addDays(focused, 7),
      PageUp: addMonths(focused, -1),
      PageDown: addMonths(focused, 1),
      Home: addDays(focused, -((new Date(`${focused}T00:00:00Z`).getUTCDay() + 6) % 7)),
      End: addDays(focused, 6 - ((new Date(`${focused}T00:00:00Z`).getUTCDay() + 6) % 7)),
    };
    const next = steps[event.key];
    if (next === undefined) return;
    event.preventDefault();
    move(next);
  };

  const weeks = monthGrid(focused);
  const header = weeks[0] ?? [];
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId]
    .filter((part) => part !== null)
    .join(' ');

  return (
    <div className="flex flex-col gap-1">
      <span id={`${id}-label`} className="text-label text-ink">
        {label}
      </span>
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          if (next) setFocused(isDay(value) ? value : allowed(today) ? today : (min ?? today));
          setOpen(next);
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-labelledby={`${id}-label ${id}-value`}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={describedBy === '' ? undefined : describedBy}
            className={cn(
              'flex h-control w-full items-center justify-between gap-2 rounded-md border-hairline bg-surface-100 px-3 text-body transition-colors duration-hover ease-standard hover:bg-surface-050 max-narrow:h-touch',
              error === undefined ? 'border-border-strong' : 'border-danger',
              value === '' ? 'text-ink-muted' : 'text-ink',
            )}
          >
            <span id={`${id}-value`}>
              {value === '' ? t('date.none') : dayName.format(asUtc(value))}
            </span>
            <Icon name="calendar" size="sm" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={4}
            collisionPadding={8}
            aria-label={label}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              move(focused);
            }}
            className="z-popover rounded-2xl border-hairline border-border-subtle bg-surface-100 p-3 shadow-float data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <button
                type="button"
                aria-label={t('date.previousMonth')}
                onClick={() => {
                  setFocused(addMonths(focused, -1));
                }}
                className="flex size-control items-center justify-center rounded-md text-ink-muted transition-colors duration-hover ease-standard hover:bg-surface-200 hover:text-ink"
              >
                <Icon name="previous" size="sm" />
              </button>
              <span aria-live="polite" className="text-label font-semibold text-ink capitalize">
                {monthName.format(asUtc(focused))}
              </span>
              <button
                type="button"
                aria-label={t('date.nextMonth')}
                onClick={() => {
                  setFocused(addMonths(focused, 1));
                }}
                className="flex size-control items-center justify-center rounded-md text-ink-muted transition-colors duration-hover ease-standard hover:bg-surface-200 hover:text-ink"
              >
                <Icon name="next" size="sm" />
              </button>
            </div>
            <div
              ref={gridRef}
              role="grid"
              aria-label={monthName.format(asUtc(focused))}
              onKeyDown={onKeyDown}
            >
              <div role="row" className="grid grid-cols-7">
                {header.map((day) => (
                  <span
                    key={day}
                    role="columnheader"
                    className="flex size-control items-center justify-center text-caption text-ink-muted uppercase max-narrow:size-touch"
                  >
                    {weekday.format(asUtc(day)).slice(0, 2)}
                  </span>
                ))}
              </div>
              {weeks.map((week) => (
                <div key={week[0]} role="row" className="grid grid-cols-7">
                  {week.map((day) => {
                    const selected = day === value;
                    const outside = monthOf(day) !== monthOf(focused);
                    return (
                      <span key={day} role="gridcell" aria-selected={selected}>
                        <button
                          type="button"
                          data-day={day}
                          tabIndex={day === focused ? 0 : -1}
                          disabled={!allowed(day)}
                          aria-label={dayName.format(asUtc(day))}
                          aria-current={day === today ? 'date' : undefined}
                          onClick={() => {
                            choose(day);
                          }}
                          className={cn(
                            dayCell,
                            selected
                              ? 'bg-accent text-on-accent'
                              : cn(
                                  'hover:bg-surface-200',
                                  outside ? 'text-ink-muted' : 'text-ink',
                                  day === today && 'font-semibold underline',
                                ),
                          )}
                        >
                          {Number(day.slice(8))}
                        </button>
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between border-t-hairline border-border-subtle pt-2">
              <button
                type="button"
                disabled={!allowed(today)}
                onClick={() => {
                  choose(today);
                }}
                className="rounded-md px-2 py-1 text-label text-ink hover:bg-surface-200 disabled:text-ink-muted"
              >
                {t('date.today')}
              </button>
              <button
                type="button"
                disabled={value === ''}
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
                className="rounded-md px-2 py-1 text-label text-ink-muted hover:bg-surface-200 hover:text-ink disabled:text-ink-muted"
              >
                {t('date.clear')}
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
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
