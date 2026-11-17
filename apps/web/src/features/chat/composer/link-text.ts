/** A link form writes ordinary Markdown, using the renderer's own address policy. */
import { SafeHref } from '@purlay/markdown';
import { insertText, type Inserted, type Selection } from './composer-text';

export const insertLink = (
  text: string,
  selection: Selection,
  label: string,
  address: string,
): Inserted | null => {
  const safe = SafeHref.of(address.trim());
  if (safe === null) return null;
  const caption = (label.trim() || safe.href)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\\[\]`*_~]/g, '\\$&');
  const destination = safe.href.replace(/[\\()<>\s]/gu, (character) =>
    character === '(' ? '%28' : character === ')' ? '%29' : encodeURIComponent(character),
  );
  return insertText(text, selection, `[${caption}](${destination})`);
};
