/**
 * What rendering a message reaches outside the page for: the highlighter and the clipboard.
 *
 * Both are arguments in the same spirit as the socket and the clock (D-46): the browser's
 * are the defaults, and a test passes a highlighter that returns what it likes (or never
 * returns, to see the plain state) and a clipboard that records. A code block never names
 * `navigator`.
 */
import { createContext, useContext } from 'react';
import { browserHighlighter, type Highlighter } from './highlight';

export interface ContentPorts {
  readonly highlight: Highlighter;
  /** Resolves when the text is on the clipboard; rejects when the browser refuses. */
  readonly copy: (text: string) => Promise<void>;
}

const browserPorts: ContentPorts = {
  highlight: browserHighlighter,
  copy: (text) => navigator.clipboard.writeText(text),
};

export const ContentPortsContext = createContext<ContentPorts>(browserPorts);

export const useContentPorts = (): ContentPorts => useContext(ContentPortsContext);
