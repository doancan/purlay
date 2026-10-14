/**
 * Says the page is in front of its person (D-143), so the server holds their pushes for this workspace
 * — what they are looking at already says it.
 *
 * Only while the document is visible and focused, on the person's own input — a key, a pointer, a
 * touch — and as the page comes to the front; the engine rations it to one word a minute. A tab left
 * open on a desk says nothing, so the phone in their pocket still buzzes.
 */
import { useEffect } from 'react';
import { useEngine } from '../../realtime/realtime-provider';
import { useWorkspace } from './workspace';

/** What counts as the person being here: their own hand on it. */
const INPUT = ['keydown', 'pointerdown', 'touchstart'] as const;

export const AttentionReporter = (): null => {
  const engine = useEngine();
  const { workspace } = useWorkspace();
  useEffect(() => {
    const say = (): void => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      engine.announceActive(workspace.id);
    };
    for (const type of INPUT) window.addEventListener(type, say, { passive: true, capture: true });
    window.addEventListener('focus', say);
    document.addEventListener('visibilitychange', say);
    // In front as it opens, or as the workspace it shows changes.
    say();
    return (): void => {
      for (const type of INPUT) window.removeEventListener(type, say, { capture: true });
      window.removeEventListener('focus', say);
      document.removeEventListener('visibilitychange', say);
    };
  }, [engine, workspace.id]);
  return null;
};
