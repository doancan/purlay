/**
 * "Purlay was updated" — one bar, beside the connection's, when this tab's build has gone (#334).
 *
 * The server keeps the current build's chunks and nothing else (D-102). A tab left open across a
 * deployment asks for chunks that are no longer there; Vite says so with `vite:preloadError`, and the
 * part that asked fails as it already knows how to (a grammar stays plain, a language stays the one
 * it was). The person is offered a reload, never given one by surprise: what they are typing is
 * kept per channel (`UX.md` §5), but a reload in the middle of a sentence is still theirs to choose.
 *
 * The event is not cancelled, so the failure still reaches the code that asked.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';

/** What Vite dispatches on `window` when a chunk it was asked for could not be loaded. */
export const STALE_BUILD_EVENT = 'vite:preloadError';

export const UpdateBar = ({
  target = window,
  reload = (): void => {
    window.location.reload();
  },
}: {
  readonly target?: EventTarget;
  readonly reload?: () => void;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const seen = (): void => {
      setStale(true);
    };
    target.addEventListener(STALE_BUILD_EVENT, seen);
    return (): void => {
      target.removeEventListener(STALE_BUILD_EVENT, seen);
    };
  }, [target]);

  if (!stale) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 bg-accent-subtle px-4 py-1 text-label text-ink"
    >
      <Icon name="info" size="sm" />
      {t('update.available')}
      <button type="button" onClick={reload} className="underline">
        {t('update.reload')}
      </button>
    </div>
  );
};
