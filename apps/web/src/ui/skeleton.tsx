/**
 * Loading is a shape, never a spinner (`UX.md` §8).
 *
 * A skeleton is the outline of what is coming — rows of the right height — so the
 * page does not jump when the content lands, and so a slow load looks like
 * progress rather than like a stuck animation. It is static on purpose: motion is
 * for the two transitions the product has (`UX.md` §9), and a shimmer on every
 * list is exactly the kind of motion that reads as lag.
 *
 * The blocks are `aria-hidden`; what a screen reader gets is `LoadingStatus`'s
 * one sentence, because "block, block, block" is not information.
 */
import { cn } from './cn';
import { VisuallyHidden } from './visually-hidden';

const skeletonClasses = 'block h-3 rounded-sm bg-surface-200 max-w-full';

/** What a message row will be: an avatar's circle and two lines, so nothing moves when it lands. */
export const SkeletonRow = ({ className }: SkeletonProps): React.JSX.Element => (
  <span aria-hidden="true" className={cn('flex gap-3 px-2 py-2', className)}>
    <span className="block size-avatar-lg shrink-0 rounded-lg bg-surface-200" />
    <span className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
      <Skeleton className="w-1/4" />
      <Skeleton className="w-3/4" />
    </span>
  </span>
);

interface SkeletonProps {
  /** A width from the vocabulary (`w-sidebar`, `w-1/2`…); full width when absent. */
  readonly className?: string;
}

export const Skeleton = ({ className }: SkeletonProps): React.JSX.Element => (
  <span aria-hidden="true" className={cn(skeletonClasses, className)} />
);

interface LoadingStatusProps {
  /** What is loading, in a sentence: "Loading messages". */
  readonly label: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}

export const LoadingStatus = ({
  label,
  className,
  children,
}: LoadingStatusProps): React.JSX.Element => (
  <div role="status" aria-busy="true" className={className}>
    <VisuallyHidden>{label}</VisuallyHidden>
    {children}
  </div>
);
