/**
 * The command palette: the primary way to move around, and keyboard-first by construction
 * (`UX.md` §1, §7).
 *
 * **A Radix dialog around a hand-written listbox** (D-98 §7). Radix publishes no combobox,
 * and `cmdk` would be a dependency on top of Radix for the one part of the pattern
 * that is a screenful: an input that *owns* focus while an option is *current*. The
 * argument for primitives is that focus and ARIA fail silently when hand-written —
 * so this is the component the keyboard-path and `axe` tests are about. The dialog
 * gives focus trapping, Escape, a click outside and the return of focus; the listbox
 * follows the WAI-ARIA combobox pattern: the input is the `combobox`, the options are
 * never focused, and `aria-activedescendant` names the current one.
 *
 * **Typing never leaves the input.** The arrows move the current option, Home and End
 * jump to the ends, Enter does it, and nothing else is stolen; the mouse can move the
 * current option only by actually moving (a list that scrolls under a still pointer
 * must not change what Enter will do).
 *
 * **A row has a tile**: a person's avatar, or the glyph of what the row is on a quiet square, so
 * the eye can sort the list by shape before it reads a word.
 *
 * **Matches are shown with weight, not colour**: the letters that matched are
 * semibold, so the emphasis survives every theme and every kind of colour vision.
 */
import { useDescribeFailure } from '../../data/failure';
import * as RadixDialog from '@radix-ui/react-dialog';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/icon';
import { Avatar } from '../../ui/avatar';
import { GroupFace } from '../conversations/group-face';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { Kbd, keyHintsClasses } from '../../ui/kbd';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { searchHref } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { useWorkspace } from '../shell/workspace';
import { GROUPS, rank, type PaletteGroup, type PaletteItem, type Shown } from './rank';
import { usePaletteItems } from './use-palette-items';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** A label with the matched letters in semibold. */
const Emphasised = ({
  text,
  positions,
}: {
  readonly text: string;
  readonly positions: readonly number[];
}): React.JSX.Element => {
  if (positions.length === 0) return <>{text}</>;
  const marked = new Set(positions);
  const runs: { readonly text: string; readonly strong: boolean }[] = [];
  // By UTF-16 position, as the matcher reports them; a run is rejoined, so a pair is never torn.
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    const strong = marked.has(index);
    const last = runs.at(-1);
    if (last?.strong === strong) runs[runs.length - 1] = { text: last.text + character, strong };
    else runs.push({ text: character, strong });
  }
  return (
    <>
      {runs.map((run, index) =>
        run.strong ? (
          <b key={index} className="font-semibold text-ink">
            {run.text}
          </b>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </>
  );
};

const GROUP_LABEL = {
  views: 'palette.group.views',
  channels: 'palette.group.channels',
  people: 'palette.group.people',
  settings: 'palette.group.settings',
  search: 'palette.group.search',
} as const satisfies Record<PaletteGroup, string>;

const Body = ({ onClose }: { readonly onClose: () => void }): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const items = usePaletteItems();
  const base = useId();
  const listId = `${base}-list`;
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  const { navigate } = useRoute();
  const { workspace } = useWorkspace();
  // Whatever was typed can always be searched for in the messages: the last row, never the only
  // way to find a channel, but the way to find what somebody said (`PRD.md` §4.6).
  const matched = useMemo(() => rank(items, query), [items, query]);
  const shown = useMemo((): readonly Shown[] => {
    const words = query.trim();
    if (words === '') return matched;
    const searching: PaletteItem = {
      id: 'search:messages',
      group: 'search',
      label: t('palette.searchFor', { query: words }),
      glyph: 'search',
      recency: '',
      run: () => {
        navigate(searchHref(workspace.slug, words));
      },
    };
    return [...matched, { item: searching, positions: [] }];
  }, [matched, query, t, navigate, workspace.slug]);
  const current = shown[selected];
  const optionId = (index: number): string => `${base}-option-${String(index)}`;

  // The current option stays in view as the arrows move it.
  useEffect(() => {
    document.getElementById(`${base}-option-${String(selected)}`)?.scrollIntoView({
      block: 'nearest',
    });
  }, [base, selected, shown]);

  const move = (to: number): void => {
    if (shown.length === 0) return;
    setSelected(((to % shown.length) + shown.length) % shown.length);
  };

  const activate = async (entry: Shown | undefined): Promise<void> => {
    if (entry === undefined || busy) return;
    setFailed(null);
    try {
      const result = entry.item.run();
      if (result instanceof Promise) {
        setBusy(true);
        await result;
      }
      onClose();
    } catch (failure) {
      setFailed(describe(failure));
    } finally {
      // A command that succeeded closes the palette; one that did not must not leave it stuck busy.
      setBusy(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // An IME confirming a character is not a command: Enter there must not activate.
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(selected + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(selected - 1);
        return;
      case 'Home':
        event.preventDefault();
        move(0);
        return;
      case 'End':
        event.preventDefault();
        move(shown.length - 1);
        return;
      case 'Enter':
        event.preventDefault();
        void activate(current);
        return;
    }
  };

  const typed = query.trim() !== '';
  const announcement = !typed
    ? ''
    : matched.length === 0
      ? t('palette.empty', { query: query.trim() })
      : t('palette.results', { count: matched.length });

  let index = -1;
  return (
    <>
      <div className="p-3 pb-2">
        <div className="flex h-control max-narrow:h-touch items-center gap-2 rounded-lg border-hairline border-border-subtle bg-surface-050 px-3 text-ink-subtle focus-within:outline-focus focus-within:outline-focus-ring focus-within:outline-offset-focus">
          <Icon name="search" />
          <input
            type="text"
            role="combobox"
            aria-label={t('palette.title')}
            aria-expanded={shown.length > 0}
            aria-controls={shown.length > 0 ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={current === undefined ? undefined : optionId(selected)}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('palette.placeholder')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
              setFailed(null);
            }}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-muted"
          />
          <Kbd>Esc</Kbd>
        </div>
      </div>

      {typed && matched.length === 0 && (
        <p className="px-4 pt-3 pb-1 text-body text-ink-muted">
          {t('palette.empty', { query: query.trim() })}
        </p>
      )}
      {shown.length === 0 ? null : (
        <div
          id={listId}
          role="listbox"
          aria-label={t('palette.listLabel')}
          // Clicking an option must not take focus from the input: the combobox keeps it.
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          className="max-h-palette-list overflow-y-auto p-2"
        >
          {GROUPS.map((group) => {
            const entries = shown.filter((entry) => entry.item.group === group);
            if (entries.length === 0) return null;
            const headingId = `${base}-group-${group}`;
            return (
              <div key={group} role="group" aria-labelledby={headingId}>
                <div
                  id={headingId}
                  role="presentation"
                  className="px-3 pb-1 pt-2 text-label text-ink-muted"
                >
                  {t(GROUP_LABEL[group])}
                </div>
                {entries.map((entry) => {
                  index += 1;
                  const mine = index;
                  const active = mine === selected;
                  return (
                    <div
                      key={entry.item.id}
                      id={optionId(mine)}
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        void activate(entry);
                      }}
                      onPointerMove={(event) => {
                        const last = pointer.current;
                        pointer.current = { x: event.clientX, y: event.clientY };
                        if (last !== null && last.x === event.clientX && last.y === event.clientY)
                          return;
                        if (!active) setSelected(mine);
                      }}
                      className={cn(
                        'flex items-center gap-3 rounded-md px-3 py-2 text-body text-ink',
                        active && 'bg-accent-subtle',
                      )}
                    >
                      {entry.item.faces !== undefined ? (
                        <GroupFace
                          peers={entry.item.faces}
                          surface={active ? 'selected' : 'surface'}
                        />
                      ) : entry.item.avatar === undefined ? (
                        <span
                          aria-hidden="true"
                          className="inline-flex size-avatar-sm shrink-0 items-center justify-center rounded-md bg-surface-200 text-ink-muted"
                        >
                          <Icon name={entry.item.glyph} />
                        </span>
                      ) : (
                        <Avatar
                          size="sm"
                          name={entry.item.avatar.name}
                          username={entry.item.avatar.username}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        <Emphasised text={entry.item.label} positions={entry.positions} />
                      </span>
                      {entry.item.hint === undefined ? null : (
                        <span className="text-caption text-ink-muted">{entry.item.hint}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {failed !== null && (
        <p role="alert" className="px-4 pb-2 text-label text-danger-text">
          {`${t('palette.error')} ${failed}`}
        </p>
      )}
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>

      <div className={cn(keyHintsClasses, 'touch-only:hidden')}>
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t('palette.hint.move')}
        </span>
        <span>
          <Kbd>Enter</Kbd> {t('palette.hint.open')}
        </span>
        <span>
          <Kbd>Esc</Kbd> {t('palette.hint.close')}
        </span>
      </div>
    </>
  );
};

export const CommandPalette = ({ open, onOpenChange }: CommandPaletteProps): React.JSX.Element => {
  const { t } = useI18n();
  const returnTo = useRef<HTMLElement | null>(null);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-palette bg-scrim" />
        <RadixDialog.Content
          className="fixed inset-x-4 top-1/6 z-palette mx-auto flex max-w-palette animate-overlay-in flex-col overflow-hidden rounded-2xl border-hairline border-border-subtle bg-surface-100 text-ink shadow-float"
          onOpenAutoFocus={() => {
            // Before Radix moves focus in, the active element is still the opener.
            returnTo.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnTo.current?.focus();
          }}
        >
          <VisuallyHidden asChild>
            <RadixDialog.Title>{t('palette.title')}</RadixDialog.Title>
          </VisuallyHidden>
          <VisuallyHidden asChild>
            <RadixDialog.Description>{t('palette.description')}</RadixDialog.Description>
          </VisuallyHidden>
          <Body
            onClose={() => {
              onOpenChange(false);
            }}
          />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
};
