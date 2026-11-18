/**
 * What the emoji autocomplete draws and matches with, loaded together on the first colon
 * (`use-emoji-names.ts`): the names, the match, and the list that shows them.
 */
import { useI18n } from '../../../i18n/i18n-provider';
import { cn } from '../../../ui/cn';
import { Kbd } from '../../../ui/kbd';
import type { ShortcodeEntry } from './emoji-shortcodes';
import { SuggestionPopover, shortcodeListId, shortcodeOptionId } from './suggestion-lists';

export { insertShortcode, shortcodeKey, suggestShortcodes } from './emoji-names';

interface ShortcodeListProps {
  readonly listId: string;
  readonly choices: readonly ShortcodeEntry[];
  readonly current: number;
  readonly onChoose: (emoji: string) => void;
  readonly onHover: (index: number) => void;
}

export const ShortcodeList = ({
  listId,
  choices,
  current,
  onChoose,
  onHover,
}: ShortcodeListProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <SuggestionPopover
      id={shortcodeListId(listId)}
      label={t('shortcode.listLabel')}
      hintsClassName="touch-only:hidden"
      hints={
        <>
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t('mention.hint.move')}
          </span>
          <span>
            <Kbd>Enter</Kbd> {t('mention.hint.insert')}
          </span>
          <span>
            <Kbd>Esc</Kbd> {t('mention.hint.close')}
          </span>
        </>
      }
    >
      {choices.map((choice, index) => (
        <div
          key={choice.name}
          id={shortcodeOptionId(listId, index)}
          role="option"
          aria-selected={index === current}
          onClick={() => {
            onChoose(choice.emoji);
          }}
          onPointerMove={() => {
            if (index !== current) onHover(index);
          }}
          className={cn(
            'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2',
            index === current && 'bg-accent-subtle',
          )}
        >
          <span aria-hidden="true" className="w-6 shrink-0 text-center text-title">
            {choice.emoji}
          </span>
          <span className="min-w-0 truncate font-mono text-body text-ink">:{choice.name}:</span>
        </div>
      ))}
    </SuggestionPopover>
  );
};
