/**
 * The bar a screen with no header of its own shows on a narrow window, so the sidebar is
 * never out of reach: a channel that is still loading, one that is not there, a workspace
 * with nothing joined yet.
 *
 * Wide, the sidebar is always on screen and this draws nothing (`hidden`); narrow, it is the
 * toggle in a header-sized strip, so the screen below it does not jump when its real header
 * arrives.
 */
import { NavToggle } from './nav';

export const ScreenBar = (): React.JSX.Element => (
  <header className="hidden h-header shrink-0 items-center border-b-hairline border-border-subtle pr-4 pl-5 max-narrow:flex">
    <NavToggle />
  </header>
);
