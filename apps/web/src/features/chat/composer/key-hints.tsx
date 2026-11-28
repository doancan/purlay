/**
 * The keys that send, break a line and open a code block, named in the composer's description.
 *
 * Not drawn: a row of key caps beside the buttons read as clutter, and the keys work without being printed
 * (D-362). They stay in the document as the field's description, because a screen reader reads that at every width.
 */
import { useI18n } from '../../../i18n/i18n-provider';
import { Kbd } from '../../../ui/kbd';
import { VisuallyHidden } from '../../../ui/visually-hidden';
import type { KeyLabels } from '../../shortcuts/platform';

export interface KeyHintsProps {
  /** The id the field's `aria-describedby` names. */
  readonly id: string;
  /** Whether Enter is a new line here (inside an open fence, or on a phone), so the key that sends is Mod+Enter (D-188). */
  readonly fenced: boolean;
  readonly labels: KeyLabels;
  readonly chord: (...parts: readonly string[]) => string;
}

export const KeyHints = ({ id, fenced, labels, chord }: KeyHintsProps): React.JSX.Element => {
  const { t } = useI18n();
  const hints = (
    <>
      <span className="whitespace-nowrap">
        <Kbd>{fenced ? chord(labels.mod, labels.enter) : 'Enter'}</Kbd> {t('composer.hint.send')}
      </span>
      <span className="whitespace-nowrap">
        <Kbd>Shift+Enter</Kbd> {t('composer.hint.newline')}
      </span>
      <span className="whitespace-nowrap">
        <Kbd>```</Kbd> {t('composer.hint.code')}
      </span>
    </>
  );
  return (
    <VisuallyHidden>
      <span id={id}>{hints}</span>
    </VisuallyHidden>
  );
};
