/**
 * A few choices shown at once, one of them chosen: the theme, the language (D-146).
 *
 * Native radio buttons inside cards, so the browser gives what a hand-built radio group forgets —
 * arrow keys move between them, one Tab stop for the group, the name read with the group's label —
 * and the radio stays visible, so the focus ring (`index.css`, the one every control shares) is
 * drawn on it rather than on a hidden input. The chosen card takes the accent's subtle tone and
 * edge; the choice applies as it is made.
 */
import { useId } from 'react';
import { Icon, type GlyphName } from '../../components/icon';
import { cn } from '../../ui/cn';
import { Radio } from '../../ui/checkbox';

interface Choice<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly description?: string;
  readonly glyph?: GlyphName;
}

interface ChoicesProps<V extends string> {
  /** The group's name, said by a screen reader as the group is entered. */
  readonly label: string;
  readonly value: V;
  readonly choices: readonly Choice<V>[];
  readonly onChange: (value: V) => void;
}

export const Choices = <V extends string>({
  label,
  value,
  choices,
  onChange,
}: ChoicesProps<V>): React.JSX.Element => {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'grid w-full gap-3 max-narrow:grid-cols-1',
        // Four fit one row (the themes); a fifth would leave one alone on the next.
        choices.length === 4 ? 'grid-cols-4' : 'grid-cols-3',
      )}
    >
      {choices.map((choice) => {
        const chosen = choice.value === value;
        return (
          <label
            key={choice.value}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border-hairline px-4 py-3 transition-colors duration-hover ease-standard',
              chosen
                ? 'border-composer-edge bg-accent-subtle'
                : 'border-border-subtle bg-surface-100 hover:bg-surface-050',
            )}
          >
            <Radio
              name={name}
              value={choice.value}
              checked={chosen}
              onChange={() => {
                onChange(choice.value);
              }}
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="flex items-center gap-2 text-label text-ink">
                {choice.glyph !== undefined && (
                  <span className="text-ink-muted">
                    <Icon name={choice.glyph} />
                  </span>
                )}
                {choice.label}
              </span>
              {choice.description !== undefined && (
                <span className="text-caption text-ink-muted">{choice.description}</span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
};
