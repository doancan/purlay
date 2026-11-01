/**
 * The track of a side-by-side group — the header's Feed | Open questions, the dialog's tabs — with the
 * mark that shows which one is chosen sliding from the old segment to the new, instead of jumping.
 *
 * The chosen segment says so in the markup (`aria-current` or `aria-selected`), and that is all this
 * reads: it measures that element and moves one absolutely placed mark under the children. When the
 * choice is a route, the track is a new element on the next screen, so where the mark last stood is kept
 * per `memory` name and the new mark starts there. The slide is the `duration-slide` token: 0ms under
 * reduced motion, so the mark simply appears at its place.
 */
import { createElement, useLayoutEffect, useRef } from 'react';
import { cn } from './cn';

type Mark = 'pill' | 'underline';

interface Place {
  readonly x: number;
  readonly width: number;
}

/** Where each named track's mark was last drawn. */
const lastPlace = new Map<string, Place>();

const markClasses: Record<Mark, string> = {
  pill: 'top-0 left-0 rounded-md bg-surface-100 shadow-card max-narrow:hidden',
  underline: 'bottom-0 left-0 border-b-marker border-accent',
};

const CHOSEN = '[aria-current="page"], [aria-selected="true"]';

export interface SlideTrackProps extends Omit<React.ComponentPropsWithoutRef<'div'>, 'ref'> {
  /** The track's element, for a caller that moves focus among its segments. */
  readonly trackRef?: React.RefObject<HTMLDivElement | null>;
  /** The track's name across screens; two tracks with one name are one control seen on two screens. */
  readonly memory: string;
  readonly mark?: Mark;
  readonly as?: 'div' | 'nav';
}

export const SlideTrack = ({
  memory,
  mark = 'pill',
  as = 'div',
  trackRef,
  className,
  children,
  ...rest
}: SlideTrackProps): React.JSX.Element => {
  const host = useRef<HTMLElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const arrived = useRef(false);

  useLayoutEffect(() => {
    const track = host.current;
    const bead = bar.current;
    if (track === null || bead === null) return;
    const place = (animate: boolean): void => {
      const chosen = track.querySelector<HTMLElement>(CHOSEN);
      if (chosen === null) {
        bead.style.opacity = '0';
        return;
      }
      const next: Place = { x: chosen.offsetLeft, width: chosen.offsetWidth };
      const from = animate && !arrived.current ? lastPlace.get(memory) : undefined;
      const draw = (at: Place): void => {
        bead.style.opacity = '1';
        bead.style.width = `${String(at.width)}px`;
        bead.style.transform = `translateX(${String(at.x)}px)`;
        if (mark === 'pill') bead.style.height = `${String(chosen.offsetHeight)}px`;
      };
      if (from === undefined || (from.x === next.x && from.width === next.width)) {
        bead.dataset['instant'] = '';
        draw(next);
      } else {
        // Start where it stood, then let the transition carry it: the frame between must be seen.
        bead.dataset['instant'] = '';
        draw(from);
        bead.getBoundingClientRect();
        delete bead.dataset['instant'];
        draw(next);
      }
      arrived.current = true;
      lastPlace.set(memory, next);
    };
    place(true);
    const observer = new ResizeObserver((): void => {
      bead.dataset['instant'] = '';
      place(false);
    });
    observer.observe(track);
    return (): void => {
      observer.disconnect();
    };
  });

  return createElement(
    as,
    {
      ...rest,
      ref: (element: HTMLElement | null): void => {
        host.current = element;
        if (trackRef !== undefined) trackRef.current = element as HTMLDivElement | null;
      },
      className: cn('relative', className),
    },
    <span
      ref={bar}
      aria-hidden="true"
      className={cn('slide-mark pointer-events-none absolute opacity-0', markClasses[mark])}
    />,
    children,
  );
};
