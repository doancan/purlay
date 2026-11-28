/**
 * A question that must be answered before something that cannot be undone: a title, one sentence, Cancel, and the
 * action in the danger variant named for what it does. Cancel and Close are the product's own words, so a caller says
 * only what is being asked. A confirmation that needs more in it (a field, a list, a pending request) builds on
 * `Dialog` itself.
 */
import { useI18n } from '../i18n/i18n-provider';
import type { GlyphName } from '../components/icon';
import { Button } from './button';
import { Dialog } from './dialog';

interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  /** What the action is called: the verb, as the button says it. */
  readonly confirmLabel: string;
  readonly confirmGlyph: GlyphName;
  /** Runs after the dialog has closed. */
  readonly onConfirm: () => void;
}

export const ConfirmDialog = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmGlyph,
  onConfirm,
}: ConfirmDialogProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            glyph={confirmGlyph}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
};
