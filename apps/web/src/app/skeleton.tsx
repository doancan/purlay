/**
 * The application frame before there is anything to put in it.
 *
 * Sidebar, header, a few message rows and the composer, drawn as shapes. It is
 * what `AppProviders` shows while the first catalogue loads, and it is the markup
 * the build will prerender into `index.html` (D-50, #141): the first paint is real
 * layout, and the JavaScript fills it rather than creating it. So it must hold no
 * hooks and no words — it cannot call `useI18n`, because the words are what it is
 * waiting for — and its widths are the same tokens the real frame uses, so nothing
 * moves when the real one replaces it. Below the breakpoint the real sidebar is an overlay,
 * not a column, so the skeleton's is not drawn there either (`max-narrow:hidden`).
 *
 * It is hidden from assistive technology on purpose: a screen reader meets the
 * real page when it arrives, and a page of "block, block, block" in between is
 * noise. `aria-busy` says the page is not ready.
 */
import { Skeleton } from '../ui/skeleton';

export const AppSkeleton = (): React.JSX.Element => (
  <div aria-hidden="true" className="flex h-screen bg-surface-100">
    <div className="flex w-sidebar shrink-0 flex-col gap-4 border-r-hairline max-narrow:hidden border-border-subtle bg-surface-000 px-2 py-3">
      <Skeleton className="mx-3 w-members" />
      <div className="flex flex-col gap-2 px-3">
        <Skeleton className="w-gutter" />
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    </div>
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-header shrink-0 items-center border-b-hairline border-border-subtle px-4">
        <Skeleton className="w-sidebar" />
      </div>
      <div className="flex flex-1 flex-col gap-4 px-4 py-4">
        {/* Message rows: the timestamp gutter, then a name and a line of text. */}
        <div className="flex gap-3">
          <span className="w-gutter shrink-0" />
          <div className="flex flex-col gap-2">
            <Skeleton className="w-members" />
            <Skeleton className="w-feed" />
          </div>
        </div>
        <div className="flex gap-3">
          <span className="w-gutter shrink-0" />
          <div className="flex flex-col gap-2">
            <Skeleton className="w-gutter" />
            <Skeleton className="w-feed" />
          </div>
        </div>
        <div className="flex gap-3">
          <span className="w-gutter shrink-0" />
          <div className="flex flex-col gap-2">
            <Skeleton className="w-members" />
            <Skeleton className="w-sidebar" />
          </div>
        </div>
      </div>
      <div className="h-header shrink-0 border-t-hairline border-border-subtle" />
    </div>
  </div>
);
