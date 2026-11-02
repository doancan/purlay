/**
 * The notes of a release, in a window (D-248): what changed, by category, each line as the markdown it was written
 * in — the area in bold, a name in code — drawn by the same renderer a message is.
 *
 * It is the product's one dialog (`ui/dialog.tsx`): labelled by its title, described by the date, focus held in it,
 * Escape and a click on the scrim closing it. Where it is opened and when is the caller's business.
 */
import type { ReleaseNotes } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { renderContent } from '../content/render-content';

export const ReleaseNotesDialog = ({
  notes,
  open,
  onOpenChange,
}: {
  readonly notes: ReleaseNotes;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      focusFirst="dialog"
      title={t('releaseNotes.title', { version: notes.version })}
      description={t('releaseNotes.description', { date: format.date(`${notes.date}T12:00:00Z`) })}
      closeLabel={t('common.close')}
      footer={
        <Button
          variant="primary"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t('releaseNotes.close')}
        </Button>
      }
    >
      {/* Long notes scroll inside the window; a keyboard reaches them by a stop of their own, or cannot scroll them. */}
      <div
        role="region"
        aria-label={t('releaseNotes.title', { version: notes.version })}
        tabIndex={0}
        className="flex max-h-inbox-panel-list flex-col gap-6 overflow-y-auto"
      >
        {notes.groups.map((group) => (
          <section key={group.category} className="flex flex-col gap-2">
            <h3 className="text-label text-ink-muted">
              {t(`releaseNotes.category.${group.category}`)}
            </h3>
            <ul className="flex flex-col gap-2">
              {group.items.map((item, index) => (
                // A release's notes are read whole and never reordered, so a position is the identity.
                <li key={index} className="text-body text-ink">
                  {renderContent(item)}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
};
