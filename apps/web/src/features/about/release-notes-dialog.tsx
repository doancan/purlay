/**
 * The notes of a release, in a window (D-248, D-261): what changed, each line as the markdown it was written in —
 * a name in code — drawn by the same renderer a message is.
 *
 * What a release is *about* comes first, when it has anything: a light blue block with each big thing as a
 * title and its sentence. Then every category is an ordinary list under a quiet heading — a coloured dot, a word
 * and a count, never a pill, which would read as a button — with the area of each line as a small label above its
 * words and a hairline between lines. The window scrolls inside itself and draws its bar only under the pointer.
 *
 * It is the product's one dialog (`ui/dialog.tsx`): labelled by its title, described by the date, focus held in it,
 * Escape and a click on the scrim closing it. A new version opens it with a show of fireworks over it; where it is
 * opened and when is the caller's business.
 */
import type { ReleaseNotes, ReleaseNotesGroup } from '@purlay/types';
import { useEffect } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { Button, buttonStyle } from '../../ui/button';
import { celebrate } from '../../ui/celebrate';
import { cn } from '../../ui/cn';
import { Dialog } from '../../ui/dialog';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { renderContent } from '../content/render-content';

/** The colour of each category's dot: a second voice beside its word, never the only one. */
const DOT: Readonly<Record<ReleaseNotesGroup['category'], string>> = {
  Featured: 'bg-accent',
  Added: 'bg-success',
  Changed: 'bg-accent',
  Deprecated: 'bg-ink-subtle',
  Removed: 'bg-ink-subtle',
  Fixed: 'bg-warning',
  Security: 'bg-danger',
};

const RELEASES = 'https://github.com/doancan/purlay/releases/tag';

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
  // A release is a moment: one show of fireworks, a few seconds, over the window as it opens (reduced motion: none).
  useEffect(() => {
    if (open) celebrate('grand');
  }, [open]);
  const featured = notes.groups.find((group) => group.category === 'Featured');
  const rest = notes.groups.filter((group) => group.category !== 'Featured');
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
        <>
          <a
            href={`${RELEASES}/v${notes.version}`}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonStyle('ghost'), 'mr-auto')}
          >
            {t('releaseNotes.github')}
            <VisuallyHidden> ({t('message.link.external')})</VisuallyHidden>
          </a>
          <Button
            variant="primary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('releaseNotes.close')}
          </Button>
        </>
      }
    >
      {/* Long notes scroll inside the window; a keyboard reaches them by a stop of its own, or cannot scroll them. */}
      <div
        role="region"
        aria-label={t('releaseNotes.title', { version: notes.version })}
        tabIndex={0}
        className="scrollbar-hover flex max-h-inbox-panel-list flex-col gap-6 overflow-y-auto"
      >
        {featured !== undefined && (
          <section className="flex flex-col gap-4 rounded-xl bg-accent-subtle p-5">
            <h3 className="text-label font-semibold text-accent-text">
              {t('releaseNotes.category.Featured')}
            </h3>
            <ul className="flex flex-col gap-4">
              {featured.items.map((item, index) => (
                // A release's notes are read whole and never reordered, so a position is the identity.
                <li key={index} className="flex flex-col gap-1">
                  {item.area !== null && (
                    <p className="text-heading font-semibold text-ink">{item.area}</p>
                  )}
                  <div className="text-body text-ink">{renderContent(item.body)}</div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {rest.map((group) => (
          <section key={group.category} className="flex flex-col">
            <h3 className="flex items-center gap-2 pb-2 text-label font-semibold text-ink">
              <span
                aria-hidden="true"
                className={cn('size-dot rounded-pill', DOT[group.category])}
              />
              {t(`releaseNotes.category.${group.category}`)}
              <span className="font-mono text-caption font-normal text-ink-muted">
                {group.items.length}
              </span>
            </h3>
            <ul className="flex flex-col">
              {group.items.map((item, index) => (
                <li
                  key={index}
                  className="flex flex-col gap-1 border-t-hairline border-border-subtle py-3"
                >
                  {item.area !== null && (
                    <span className="text-caption font-medium text-ink-muted">{item.area}</span>
                  )}
                  <div className="min-w-0 text-body text-ink">{renderContent(item.body)}</div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
};
