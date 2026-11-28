/**
 * What rendering a message reaches outside the page for: the highlighter and the clipboard.
 *
 * Both are arguments in the same spirit as the socket and the clock (D-46): the browser's
 * are the defaults, and a test passes a highlighter that returns what it likes (or never
 * returns, to see the plain state) and a clipboard that records. A code block never names
 * `navigator`.
 */
import { createContext, useCallback, useContext } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { useToast } from '../../ui/toast';
import { browserHighlighter, type Highlighter } from './highlight';

export interface ContentPorts {
  readonly highlight: Highlighter;
  /** Resolves when the text is on the clipboard; rejects when the browser refuses. */
  readonly copy: (text: string) => Promise<void>;
}

const browserPorts: ContentPorts = {
  highlight: browserHighlighter,
  // `navigator.clipboard` is absent outside a secure context: that is a refusal to report, not a throw.
  copy: async (text) => {
    await navigator.clipboard.writeText(text);
  },
};

export const ContentPortsContext = createContext<ContentPorts>(browserPorts);

export const useContentPorts = (): ContentPorts => useContext(ContentPortsContext);

/**
 * Puts text on the clipboard and says what happened: "Copied", or that the browser refused (outside a secure context,
 * or without permission), so a person knows to select it by hand. The same ten lines were written at fifteen call
 * sites. `copied` is the words for success where the generic "Copied" is not what was copied ("Link copied").
 */
export const useCopier = (): ((text: string, copied?: string) => void) => {
  const { copy } = useContentPorts();
  const { show } = useToast();
  const { t } = useI18n();
  return useCallback(
    (text, copied) => {
      copy(text).then(
        () => {
          show({ message: copied ?? t('common.copied') });
        },
        () => {
          show({ message: t('failure.copy') });
        },
      );
    },
    [copy, show, t],
  );
};
