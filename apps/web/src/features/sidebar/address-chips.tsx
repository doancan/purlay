/**
 * E-mail addresses typed as chips (`UX.md` §2, Invite people): Enter or a comma makes what is typed a
 * chip, × or Backspace on an empty field takes one away, a paste of several makes several. A chip that
 * is not an address stays, in the danger colour *and* with a word and a glyph — never colour alone — so
 * it can be corrected, and it is never sent (`sendable`). An address typed again, in any case, is one.
 *
 * Controlled: the addresses are the caller's, who sends them. The field's label, hint and error are
 * wired as `TextField`'s are.
 */
import { normalisedMailbox } from '@purlay/types';
import { useId, useState } from 'react';
import { Icon } from '../../components/icon';
import { cn } from '../../ui/cn';
import { VisuallyHidden } from '../../ui/visually-hidden';

/** The addresses among `typed` that can be sent to, as they would be stored. */
export const sendable = (typed: readonly string[]): string[] =>
  typed.flatMap((address) => normalisedMailbox(address) ?? []);

/** What was typed or pasted, as separate addresses: commas, semicolons and white space part them. */
const split = (text: string): string[] =>
  text
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');

export const AddressChips = ({
  label,
  hint,
  placeholder,
  removeLabel,
  invalidLabel,
  tooMany,
  addresses,
  onChange,
  max,
  disabled = false,
}: {
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
  readonly removeLabel: (address: string) => string;
  readonly invalidLabel: string;
  /** Said under the field when an address was left out for the limit. */
  readonly tooMany: string;
  readonly addresses: readonly string[];
  readonly onChange: (addresses: readonly string[]) => void;
  readonly max: number;
  readonly disabled?: boolean;
}): React.JSX.Element => {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [full, setFull] = useState(false);

  const add = (text: string): void => {
    const seen = new Set(addresses.map((address) => address.toLowerCase()));
    const next = [...addresses];
    let left = false;
    for (const part of split(text)) {
      if (seen.has(part.toLowerCase())) continue;
      if (next.length >= max) {
        left = true;
        continue;
      }
      seen.add(part.toLowerCase());
      next.push(part);
    }
    setFull(left);
    onChange(next);
    setDraft('');
  };

  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-ink">
        {label}
      </label>
      <div
        className={cn(
          'flex min-h-control flex-wrap items-center gap-1 rounded-md border-hairline border-border-strong bg-surface-100 p-1 focus-within:outline-focus focus-within:outline-focus-ring focus-within:-outline-offset-focus',
          disabled && 'bg-surface-200',
        )}
      >
        {addresses.map((address, index) => {
          const valid = normalisedMailbox(address) !== undefined;
          return (
            <span
              key={address.toLowerCase()}
              className={cn(
                'inline-flex max-w-full items-center gap-1 rounded-pill py-1 pr-1 pl-2 text-caption',
                valid ? 'bg-accent-subtle text-accent-text' : 'bg-danger-subtle text-danger-text',
              )}
            >
              {valid ? null : <Icon name="failed" size="sm" />}
              <span className="min-w-0 break-all">{address}</span>
              {valid ? null : <VisuallyHidden>{invalidLabel}</VisuallyHidden>}
              <button
                type="button"
                disabled={disabled}
                aria-label={removeLabel(address)}
                onClick={() => {
                  setFull(false);
                  onChange(addresses.filter((_, at) => at !== index));
                }}
                className="inline-flex h-badge min-w-badge shrink-0 items-center justify-center rounded-pill hover:bg-surface-200"
              >
                <Icon name="close" size="sm" />
              </button>
            </span>
          );
        })}
        <input
          id={id}
          type="text"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={disabled}
          value={draft}
          placeholder={addresses.length === 0 ? placeholder : ''}
          aria-describedby={hintId}
          onChange={(event) => {
            const text = event.target.value;
            // A comma ends an address as Enter does; what followed it starts the next.
            if (text.includes(',')) add(text);
            else setDraft(text);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              // Never the form's: the address is added, nothing is sent until the button says so.
              event.preventDefault();
              if (draft.trim() !== '') add(draft);
            } else if (event.key === 'Backspace' && draft === '' && addresses.length > 0) {
              setFull(false);
              onChange(addresses.slice(0, -1));
            }
          }}
          onBlur={() => {
            if (draft.trim() !== '') add(draft);
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            if (split(text).length > 1) {
              event.preventDefault();
              add(`${draft} ${text}`);
            }
          }}
          className="h-control min-w-0 flex-1 basis-1/3 bg-transparent px-2 text-body text-ink outline-none placeholder:text-ink-muted max-narrow:h-touch"
        />
      </div>
      <p id={hintId} className="text-caption text-ink-muted">
        {hint}
      </p>
      {full && (
        <p role="alert" className="flex items-center gap-1 text-caption text-danger-text">
          <Icon name="failed" size="sm" />
          {tooMany}
        </p>
      )}
    </div>
  );
};
