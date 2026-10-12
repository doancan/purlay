/**
 * Where the rail and the sidebar go: in the layout on a wide window, in a dialog on a narrow one.
 *
 * Wide, they are beside the page, `w-rail` and `w-sidebar`. Narrow (`UX.md` §2) they are one
 * panel over the page's left edge with the conversation dimmed behind it, and everything a
 * panel like that has to do is Radix's, not hand-written, because focus and ARIA fail silently
 * when they are: Tab stays inside, Escape and a click on the scrim close it, the page behind is
 * hidden from a screen reader, and the body does not scroll under it. What the frame adds is
 * where focus lands afterwards (`nav.tsx`): the toggle when the person dismissed it, the page
 * when they chose somewhere.
 *
 * The title and description are required by the primitive and are not drawn: the sidebar's own
 * headings say what is in it, and a dialog with no name is announced as nothing.
 */
import * as RadixDialog from '@radix-ui/react-dialog';
import { useI18n } from '../../i18n/i18n-provider';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { returnFocus, useNav } from './nav';
import { Rail } from './rail';
import { Sidebar } from './sidebar';

export const SidebarSlot = (): React.JSX.Element => {
  const { t } = useI18n();
  const nav = useNav();
  if (nav?.narrow !== true) {
    return (
      <>
        <Rail />
        <Sidebar />
      </>
    );
  }
  return (
    <RadixDialog.Root open={nav.open} onOpenChange={nav.setOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-overlay bg-scrim" />
        <RadixDialog.Content
          id={nav.panelId}
          className="fixed inset-y-0 left-0 z-overlay flex max-w-full shadow-float outline-none"
          onCloseAutoFocus={(event) => {
            // The dialog is controlled and its opener is not a Radix trigger: focus is ours to place.
            event.preventDefault();
            returnFocus(nav);
          }}
        >
          <RadixDialog.Title asChild>
            <VisuallyHidden>{t('sidebar.label')}</VisuallyHidden>
          </RadixDialog.Title>
          <RadixDialog.Description asChild>
            <VisuallyHidden>{t('nav.description')}</VisuallyHidden>
          </RadixDialog.Description>
          <Rail overlay />
          <Sidebar overlay />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
};
