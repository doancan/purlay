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
  pill: 'left-0 rounded-md bg-surface-100 shadow-card max-narrow:hidden',
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
    const draw = (at: Place, box: DOMRect, origin: DOMRect): void => {
      bead.style.opacity = '1';
      bead.style.width = `${String(at.width)}px`;
      bead.style.transform = `translateX(${String(at.x)}px)`;
      // The track pads its segments in, so the mark takes the segment's own top and height, not the track's.
      if (mark === 'pill') {
        bead.style.top = `${String(box.y - origin.y - track.clientTop)}px`;
        bead.style.height = `${String(box.height)}px`;
      }
    };
    /** Draws with the transition off, then on again: a jump the eye is not meant to follow. */
    const jump = (at: Place, box: DOMRect, origin: DOMRect): void => {
      bead.dataset['instant'] = '';
      draw(at, box, origin);
      bead.getBoundingClientRect();
      delete bead.dataset['instant'];
    };
    const place = (slide: boolean): void => {
      const chosen = track.querySelector<HTMLElement>(CHOSEN);
      if (chosen === null) {
        bead.style.opacity = '0';
        return;
      }
      // Fractions of a pixel, from the boxes themselves: a rounded offset left the mark half a pixel off.
      const box = chosen.getBoundingClientRect();
      const origin = track.getBoundingClientRect();
      const next: Place = { x: box.x - origin.x - track.clientLeft, width: box.width };
      if (!slide) {
        jump(next, box, origin);
      } else if (!arrived.current) {
        // A new track starts where the last one with its name stood, and slides from there.
        jump(lastPlace.get(memory) ?? next, box, origin);
        draw(next, box, origin);
      } else {
        draw(next, box, origin);
      }
      arrived.current = true;
      lastPlace.set(memory, next);
    };
    place(true);
    // The first report is the observer starting, not a change: acting on it would cut a slide short.
    let started = false;
    const observer = new ResizeObserver((): void => {
      if (!started) {
        started = true;
        return;
      }
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
