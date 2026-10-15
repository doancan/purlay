/**
 * The page's one `<main>`, the target of the skip link and of the focus the router
 * moves on every navigation (`app/app.tsx`).
 *
 * `tabIndex={-1}`: focusable by script and by a click, never by Tab, so moving focus
 * here announces the new content without putting an extra stop in the tab order. A
 * screen renders exactly one.
 *
 * **It takes focus when it appears after a navigation, not only when the address
 * changes.** A route that has to ask the server who the person is shows a skeleton
 * first, and `<main>` does not exist yet at the moment the address changes; focusing
 * "main" then finds nothing and the keyboard user is left on a link in a page that has
 * gone. The frame says a navigation has happened (`MainFocus`), and the `<main>` that
 * mounts afterwards claims focus itself.
 */
import { createContext, useContext, useEffect, useRef } from 'react';
import { cn } from './cn';

/** The id the skip link and the router address. */
export const MAIN_ID = 'main';

/**
 * What the frame tells a `<main>` as it mounts: whether the address has changed at least once, and
 * whether a field the new page focused for itself keeps focus (a wide window) or `<main>` takes it
 * anyway (a narrow one, where a focused field opens the on-screen keyboard over the page, #697).
 */
export interface MainFocusState {
  readonly navigated: { current: boolean };
  readonly keepsField: { current: boolean };
}

export const MainFocus = createContext<MainFocusState>({
  navigated: { current: false },
  keepsField: { current: false },
});

/**
 * Moves focus to `<main>` — unless the new page has already put it on a field of its own inside
 * it and that is to be kept, as a channel's composer on a wide window: that field is where a
 * keyboard goes next, and its label says where the person is (#697). Its effect runs before this
 * one, so taking focus back would leave the composer dozens of Tab presses away.
 */
export const takeFocus = (main: HTMLElement | null, keepsField: boolean): void => {
  if (main === null) return;
  const current = document.activeElement;
  if (keepsField && current !== null && current !== main && main.contains(current)) return;
  main.focus();
};

export const Main = ({
  className,
  ...rest
}: React.ComponentPropsWithoutRef<'main'>): React.JSX.Element => {
  const element = useRef<HTMLElement>(null);
  const { navigated, keepsField } = useContext(MainFocus);
  useEffect(() => {
    if (navigated.current) takeFocus(element.current, keepsField.current);
  }, [navigated, keepsField]);
  return (
    <main
      id={MAIN_ID}
      ref={element}
      tabIndex={-1}
      className={cn('outline-none', className)}
      {...rest}
    />
  );
};
