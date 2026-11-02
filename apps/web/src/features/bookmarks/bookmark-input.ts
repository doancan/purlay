/**
 * What a person types for a bookmark, made into what the contract holds (D-218): an address with its
 * scheme — `docs.example.com` is read as `https://docs.example.com`, as a browser's address bar reads
 * it — and a name, the site's own when none is given. The server stays the authority on both.
 */
import { BOOKMARK_TITLE_MAX } from '@purlay/types';

const WEB = /^https?:\/\//i;
/** A scheme written out (`mailto:`, `javascript:`, `ftp://`): left as typed, for the check to refuse. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The address as it will be kept, or null when it is not a web address. */
export const bookmarkUrl = (typed: string): string | null => {
  const trimmed = typed.trim();
  if (trimmed === '') return null;
  const written = WEB.test(trimmed) || SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(written);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // Whitespace inside is not an address a browser would follow; the contract refuses it too.
  if (/\s/.test(written) || parsed.hostname === '') return null;
  return written;
};

/** The name given, or the site's own (`docs.example.com`), cut to what a chip holds. */
export const bookmarkTitle = (typed: string, url: string): string => {
  const given = typed.trim();
  const name = given === '' ? new URL(url).hostname.replace(/^www\./, '') : given;
  // Cut in code units, as the contract counts, never through the middle of a character's pair.
  return name.slice(0, BOOKMARK_TITLE_MAX).replace(/[\uD800-\uDBFF]$/, '');
};
