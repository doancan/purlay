/**
 * The emoji picker (D-181): a grid of the emoji a working team reaches for, in four groups, opened from
 * the composer. Choosing one writes it where the caret is; it is text like any other, and sends as typed.
 *
 * Curated, not complete: a list of three thousand with a search is a product of its own, and Unicode's
 * own emoji keyboard is one keystroke away on every platform for anyone who wants all of them. Each tile
 * is named by its emoji, which assistive technology reads as the emoji's own name.
 */
import { useI18n } from '../../../i18n/i18n-provider';
import { lazy, Suspense } from 'react';
import { IconButton } from '../../../ui/icon-button';
import { Menu } from '../../../ui/menu';
import type * as EmojiChoiceModule from './emoji-choices';

const choices = (): Promise<typeof EmojiChoiceModule> => import('./emoji-choices');
const EmojiChoices = lazy(() => choices().then((module) => ({ default: module.EmojiChoices })));

export const EmojiPicker = ({
  onPick,
  onClosed,
}: {
  /** The emoji chosen. */
  readonly onPick: (emoji: string) => void;
  /** Where the focus goes when the picker closes: the box the person was writing in, not the button. */
  readonly onClosed: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Menu
      align="start"
      side="top"
      returnFocus={() => {
        onClosed();
        return false;
      }}
      trigger={
        <IconButton
          label={t('composer.emoji')}
          glyph="emoji"
          onFocus={() => {
            void choices();
          }}
          onPointerEnter={() => {
            void choices();
          }}
        />
      }
    >
      <Suspense fallback={null}>
        <EmojiChoices onPick={onPick} />
      </Suspense>
    </Menu>
  );
};
