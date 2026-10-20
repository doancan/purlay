/**
 * The keyboard shortcuts, as a reference a person can open from the keyboard
 * (`Cmd/Ctrl+/`, `UX.md` §7).
 *
 * **Only shortcuts that exist are listed.** A reference that promises `E` for edit when
 * editing is not built (O-1) is worse than none: it teaches a person to press a key
 * that does nothing. Each row is a sentence and one or more key sequences (`↑` *or*
 * `↓`), the modifiers spelled for the platform in front of them.
 */
import { useI18n } from '../../i18n/i18n-provider';
import { Dialog } from '../../ui/dialog';
import { Kbd } from '../../ui/kbd';
import { keyLabels, type KeyLabels } from './platform';

export interface ShortcutsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Whether to print ⌘ ⇧ ⌥ rather than Ctrl, Shift, Alt. */
  readonly mac: boolean;
}

type RowKey =
  | 'shortcuts.palette'
  | 'shortcuts.reference'
  | 'shortcuts.settings'
  | 'shortcuts.close'
  | 'shortcuts.channels'
  | 'shortcuts.rowMenu'
  | 'shortcuts.deepWork'
  | 'shortcuts.move'
  | 'shortcuts.thread'
  | 'shortcuts.reply'
  | 'shortcuts.edit'
  | 'shortcuts.resolve'
  | 'shortcuts.send'
  | 'shortcuts.newline'
  | 'shortcuts.codeSend';

type GroupKey =
  'shortcuts.group.navigation' | 'shortcuts.group.messages' | 'shortcuts.group.composer';

interface Row {
  readonly label: RowKey;
  /** Alternatives; each is the keys pressed together, in order. */
  readonly keys: (k: KeyLabels) => readonly (readonly string[])[];
}

const GROUPS: readonly { readonly title: GroupKey; readonly rows: readonly Row[] }[] = [
  {
    title: 'shortcuts.group.navigation',
    rows: [
      { label: 'shortcuts.palette', keys: (k) => [[k.mod, 'K']] },
      { label: 'shortcuts.reference', keys: (k) => [[k.mod, '/']] },
      { label: 'shortcuts.settings', keys: (k) => [[k.mod, ',']] },
      { label: 'shortcuts.close', keys: (k) => [[k.escape]] },
      {
        label: 'shortcuts.channels',
        keys: (k) => [
          [k.alt, '↑'],
          [k.alt, '↓'],
        ],
      },
      { label: 'shortcuts.rowMenu', keys: (k) => [[k.shift, 'F10']] },
      { label: 'shortcuts.deepWork', keys: (k) => [[k.mod, k.shift, 'D']] },
    ],
  },
  {
    title: 'shortcuts.group.messages',
    rows: [
      { label: 'shortcuts.move', keys: () => [['↑'], ['↓']] },
      { label: 'shortcuts.thread', keys: () => [['T']] },
      { label: 'shortcuts.reply', keys: () => [['R']] },
      { label: 'shortcuts.edit', keys: () => [['E']] },
      { label: 'shortcuts.resolve', keys: (k) => [[k.mod, k.shift, 'R']] },
    ],
  },
  {
    title: 'shortcuts.group.composer',
    rows: [
      { label: 'shortcuts.send', keys: (k) => [[k.enter]] },
      { label: 'shortcuts.newline', keys: (k) => [[k.shift, k.enter]] },
      { label: 'shortcuts.codeSend', keys: (k) => [[k.mod, k.enter]] },
    ],
  },
];

/** The reference itself: the groups and their rows, as the dialog and the settings page both show it. */
export const ShortcutList = ({
  mac,
  level = 3,
}: {
  readonly mac: boolean;
  /** The groups' heading level: below a dialog's title, or a page's. */
  readonly level?: 2 | 3;
}): React.JSX.Element => {
  const { t } = useI18n();
  const labels = keyLabels(mac);
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <>
      {GROUPS.map((group) => (
        <section key={group.title} aria-labelledby={group.title} className="flex flex-col gap-2">
          <Heading id={group.title} className="text-label text-ink-muted">
            {t(group.title)}
          </Heading>
          <ul className="flex flex-col gap-2">
            {group.rows.map((row) => (
              <li key={row.label} className="flex items-center justify-between gap-4">
                <span className="text-body text-ink">{t(row.label)}</span>
                <span className="flex items-center gap-2">
                  {row.keys(labels).map((sequence, at) => (
                    <span key={sequence.join('+')} className="flex items-center gap-1">
                      {at > 0 && (
                        <span className="text-caption text-ink-muted">{t('shortcuts.or')}</span>
                      )}
                      {sequence.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
};

export const ShortcutsDialog = ({
  open,
  onOpenChange,
  mac,
}: ShortcutsDialogProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('shortcuts.title')}
      description={t('shortcuts.description')}
      closeLabel={t('common.close')}
    >
      {/* Focusable on purpose: with nothing else to focus, Radix focuses the close button,
          whose tooltip then takes the first Escape and the dialog needs two. Focus lands on
          the list, which is also what a keyboard user wants to read. */}
      <div
        role="region"
        tabIndex={0}
        aria-label={t('shortcuts.title')}
        className="flex flex-col gap-4"
      >
        <ShortcutList mac={mac} />
      </div>
    </Dialog>
  );
};
