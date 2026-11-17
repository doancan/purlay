/** Fit wrapped lines as well as explicit newlines, without letting a draft consume the feed. */
import { useCallback, useLayoutEffect, type RefObject } from 'react';

const MIN_LINES = 2;
const MAX_LINES = 12;
const VIEWPORT_SHARE = 0.4;

export const useComposerSize = (
  field: RefObject<HTMLTextAreaElement | null>,
  preview: RefObject<HTMLDivElement | null>,
  text: string,
  previewing: boolean,
): void => {
  const fit = useCallback((): void => {
    const box = field.current;
    if (box === null) return;
    const style = getComputedStyle(box);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    if (!Number.isFinite(line)) return;
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    const minimum = line * MIN_LINES;
    const maximum = Math.max(minimum, Math.min(line * MAX_LINES, viewport * VIEWPORT_SHARE));
    if (preview.current !== null) preview.current.style.maxHeight = `${String(maximum)}px`;
    if (box.hidden) return;
    const previousScroll = box.scrollTop;
    const atBottom = previousScroll + box.clientHeight >= box.scrollHeight - 1;
    box.style.height = 'auto';
    box.style.height = `${String(Math.min(maximum, Math.max(minimum, box.scrollHeight)))}px`;
    box.scrollTop = atBottom ? box.scrollHeight - box.clientHeight : previousScroll;
  }, [field, preview]);

  useLayoutEffect(fit, [fit, text, previewing]);
  useLayoutEffect(() => {
    const box = field.current;
    if (box === null) return;
    let width = box.getBoundingClientRect().width;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((): void => {
            const next = box.getBoundingClientRect().width;
            if (next === width) return;
            width = next;
            fit();
          });
    observer?.observe(box);
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    return (): void => {
      observer?.disconnect();
      window.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('resize', fit);
    };
  }, [field, fit]);
};
