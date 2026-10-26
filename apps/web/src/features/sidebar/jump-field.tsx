/**
 * The way into the command palette that a mouse can find (`UX.md` §2, §7): a pill that looks
 * like the field it opens and says which key does the same.
 *
 * The palette is the product's primary navigation, and until this field existed its only door
 * was a chord nobody had been told about. It is a button, not an input — typing happens in the
 * palette, which owns the focus, the results and the keyboard model — so there is nothing to
 * keep in step and a click lands in the same room `Cmd/Ctrl+K` does. Where nothing renders the
 * palette (a sidebar mounted alone) it is not drawn: a button that does nothing is worse than
 * none.
 */
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Kbd } from '../../ui/kbd';
import { useOverlayDoor } from '../shell/overlay';
import { isMacPlatform, keyLabels } from '../shortcuts/platform';

export const JumpField = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const open = useOverlayDoor();
  if (open === null) return null;
  const { mod } = keyLabels(isMacPlatform(navigator));
  return (
    <button
      type="button"
      onClick={open}
      aria-keyshortcuts="Control+K Meta+K"
      className="flex h-row w-full shrink-0 items-center gap-2 rounded-md border-hairline border-nav-border bg-nav-hover px-2 text-label text-nav-ink-muted transition-colors duration-hover ease-standard hover:text-nav-ink max-narrow:h-touch"
    >
      <Icon name="search" />
      <span className="flex-1 text-left">{t('sidebar.jump')}</span>
      <Kbd tone="nav">{`${mod}K`}</Kbd>
    </button>
  );
};
