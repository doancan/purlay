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
import type { PlainKey } from '../../i18n/types';
import type { ModuleShortcut } from '../../modules/manifest';
import { running } from '../../modules/registry';
import { Dialog } from '../../ui/dialog';
import { Kbd } from '../../ui/kbd';
import { keyLabels, type KeyLabels } from './platform';

export interface ShortcutsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Whether to print ⌘ ⇧ ⌥ rather than Ctrl, Shift, Alt. */
  readonly mac: boolean;
  /** The modules the server runs (D-250): the keys of one that is not run are not listed. */
  readonly modules: readonly string[];
}

interface Row {
  readonly label: PlainKey;
  /** Alternatives; each is the keys pressed together, in order. */
  readonly keys: (k: KeyLabels) => readonly (readonly string[])[];
}

interface Group {
  readonly title: PlainKey;
  readonly rows: readonly Row[];
}

/** The core's keys. A module's rows are in its manifest (D-250), placed where it says. */
const CORE_GROUPS: readonly Group[] = [
  {
    title: 'shortcuts.group.navigation',
    rows: [
      { label: 'shortcuts.palette', keys: (k) => [[k.mod, 'K']] },
      { label: 'shortcuts.reference', keys: (k) => [[k.mod, '/']] },
      { label: 'shortcuts.settings', keys: (k) => [[k.mod, ',']] },
      { label: 'shortcuts.close', keys: (k) => [[k.escape]] },
      { label: 'shortcuts.deepWork', keys: (k) => [[k.mod, k.shift, 'D']] },
    ],
  },
];

/**
 * The groups of the modules a server runs: the core's, with each module's rows after the row its manifest names
 * (or last in its group), and a group of its own where no core group has the name.
 */
const groupsFor = (modules: readonly string[]): readonly Group[] =>
  running(modules)
    .flatMap((module): readonly ModuleShortcut[] => module.shortcuts)
    .reduce<readonly Group[]>((groups, row) => {
      if (!groups.some((group) => group.title === row.group)) {
        return [...groups, { title: row.group, rows: [row] }];
      }
      return groups.map((group) => {
        if (group.title !== row.group) return group;
        const after = group.rows.findIndex((own) => own.label === row.after);
        const at = after === -1 ? group.rows.length : after + 1;
        return { ...group, rows: [...group.rows.slice(0, at), row, ...group.rows.slice(at)] };
      });
    }, CORE_GROUPS);

/** The reference itself: the groups and their rows, as the dialog and the settings page both show it. */
export const ShortcutList = ({
  mac,
  modules,
  level = 3,
}: {
  readonly mac: boolean;
  readonly modules: readonly string[];
  /** The groups' heading level: below a dialog's title, or a page's. */
  readonly level?: 2 | 3;
}): React.JSX.Element => {
  const { t } = useI18n();
  const labels = keyLabels(mac);
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <>
      {groupsFor(modules).map((group) => (
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
  modules,
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
        <ShortcutList mac={mac} modules={modules} />
      </div>
    </Dialog>
  );
};
