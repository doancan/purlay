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

/** Set by the frame once the address has changed at least once; read by a `<main>` as it mounts. */
export const MainFocus = createContext<{ current: boolean }>({ current: false });

export const Main = ({
  className,
  ...rest
}: React.ComponentPropsWithoutRef<'main'>): React.JSX.Element => {
  const element = useRef<HTMLElement>(null);
  const navigated = useContext(MainFocus);
  useEffect(() => {
    if (navigated.current) element.current?.focus();
  }, [navigated]);
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
