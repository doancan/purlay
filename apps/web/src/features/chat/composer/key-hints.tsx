/**
 * The keys that send, break a line and open a code block, printed under the composer's box.
 *
 * Always in the document, because the field's description names them and a screen reader reads that at
 * every width; drawn only where there is room and a keyboard (`drawn`).
 */
import { useI18n } from '../../../i18n/i18n-provider';
import { Kbd } from '../../../ui/kbd';
import { VisuallyHidden } from '../../../ui/visually-hidden';
import type { KeyLabels } from '../../shortcuts/platform';

export interface KeyHintsProps {
  /** The id the field's `aria-describedby` names. */
  readonly id: string;
  readonly drawn: boolean;
  /** Whether Enter is a new line here (inside an open fence, or on a phone), so the key that sends is Mod+Enter (D-188). */
  readonly fenced: boolean;
  readonly labels: KeyLabels;
  readonly chord: (...parts: readonly string[]) => string;
}

export const KeyHints = ({
  id,
  drawn,
  fenced,
  labels,
  chord,
}: KeyHintsProps): React.JSX.Element => {
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
  return drawn ? (
    // Each hint whole. Not drawn on a narrow window: a phone's keyboard has no Shift+Enter, and drawn
    // there they took a row of their own, so focusing the composer made it taller and moved what was
    // above it — a pill moved between a press and its release, and the click missed (#654). Nor where
    // there is no keyboard to press them on. They are still the field's description, which a screen
    // reader reads.
    <span
      id={id}
      className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-caption text-ink-muted max-narrow:hidden touch-only:hidden"
    >
      {hints}
    </span>
  ) : (
    <VisuallyHidden>
      <span id={id}>{hints}</span>
    </VisuallyHidden>
  );
};
