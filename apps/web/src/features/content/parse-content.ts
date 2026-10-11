/**
 * A message's text, read as exactly three things and otherwise left alone (D-98 §4).
 *
 * The markdown pipeline is Phase 1 and its renderer and the server's sanitiser are chosen
 * together (O-6), so this is not markdown. It knows **fenced code**, **inline code** and
 * **bare `http(s)` links**, plus the `@name` shape a mention takes so the renderer can
 * highlight the ones that are real; everything else is the person's own characters, line
 * breaks kept. It produces data, never markup — there is no HTML here to sanitise, which
 * is the point.
 *
 * **Linear, on purpose.** A message is up to 16,000 code units and anyone can send one, so
 * every rule here is a single forward scan with no backtracking: a closing backtick is
 * looked for with `indexOf` from where the opening one was and never again from before it,
 * a link and a mention are read with a loop that only moves forward. An input built to
 * make a regular expression back out of itself costs the same as any other.
 *
 * What is not recognised is left literal, never half-recognised: a fence with no closing
 * line is the text it was typed as, a backtick with no partner is a backtick.
 */

export type Inline =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'code'; readonly value: string }
  | { readonly kind: 'link'; readonly href: string; readonly label: string }
  /** `@name` as typed; whether it is a real mention is for whoever knows the members. */
  | { readonly kind: 'mention'; readonly name: string; readonly raw: string };

export type Block =
  | { readonly kind: 'text'; readonly inline: readonly Inline[] }
  | { readonly kind: 'fence'; readonly language: string; readonly code: string };

/** The characters a username is made of (GitHub's: letters, digits, single hyphens inside). */
const isNameChar = (c: string): boolean => /[A-Za-z0-9-]/.test(c);
const isWordChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

/** Punctuation that ends a sentence rather than an address. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', "'", '"']);

const LINK_START = /^https?:\/\//i;

/** A URL the browser may be sent to: http or https, and a host. Anything else is text. */
const safeHref = (candidate: string): string | null => {
  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
      ? url.href
      : null;
  } catch {
    return null;
  }
};

/** Where a link written at `start` ends: the first whitespace or angle bracket, less trailing punctuation. */
const linkEnd = (text: string, start: number): number => {
  let end = start;
  while (end < text.length) {
    const c = text.charAt(end);
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '<' || c === '>') break;
    end += 1;
  }
  while (end > start && TRAILING.has(text.charAt(end - 1))) end -= 1;
  return end;
};

/** One run of text with no fence in it, as inline pieces. */
const inlineOf = (text: string): Inline[] => {
  const out: Inline[] = [];
  let plain = 0;
  let i = 0;
  // The newline after the cursor, found once per line rather than once per backtick.
  let newline = text.indexOf('\n');
  // Once no backtick is left anywhere ahead, none can pair with a later one either.
  let backticksLeft = true;

  const flush = (to: number): void => {
    if (to > plain) out.push({ kind: 'text', value: text.slice(plain, to) });
  };

  while (i < text.length) {
    const c = text.charAt(i);
    if (newline !== -1 && i > newline) newline = text.indexOf('\n', i);

    if (c === '`' && backticksLeft) {
      const close = text.indexOf('`', i + 1);
      if (close === -1) {
        backticksLeft = false;
      } else if ((newline === -1 || close < newline) && close > i + 1) {
        flush(i);
        out.push({ kind: 'code', value: text.slice(i + 1, close) });
        i = close + 1;
        plain = i;
        continue;
      }
    } else if (
      (c === 'h' || c === 'H') &&
      (i === 0 || !isWordChar(text.charAt(i - 1))) &&
      LINK_START.test(text.slice(i, i + 8))
    ) {
      const end = linkEnd(text, i);
      const href = safeHref(text.slice(i, end));
      if (href !== null) {
        flush(i);
        out.push({ kind: 'link', href, label: text.slice(i, end) });
        i = end;
        plain = i;
        continue;
      }
    } else if (c === '@' && (i === 0 || !/[A-Za-z0-9_@`]/.test(text.charAt(i - 1)))) {
      // TODO(#43): a copy of `mentionsIn` (`@purlay/markdown`), which disagrees on letters outside
      // ASCII; the renderer that replaces this file highlights with the shared pattern.
      let end = i + 1;
      while (end < text.length && end - i <= 39 && isNameChar(text.charAt(end))) end += 1;
      // A name starts and ends with a letter or digit, so a trailing hyphen is not part of it.
      while (end > i + 1 && text.charAt(end - 1) === '-') end -= 1;
      if (end > i + 1 && text.charAt(i + 1) !== '-') {
        flush(i);
        const raw = text.slice(i, end);
        out.push({ kind: 'mention', name: raw.slice(1), raw });
        i = end;
        plain = i;
        continue;
      }
    }
    i += 1;
  }
  flush(text.length);
  return out;
};

/**
 * The fence an opening line starts, if it is one: three backticks at the start of the
 * line (up to three spaces of indent) and an info string whose first word is the language.
 */
const openingFence = (line: string): string | null => {
  const trimmed = line.replace(/^ {0,3}/, '');
  if (!trimmed.startsWith('```')) return null;
  const info = trimmed.slice(3).trim();
  // A backtick in the info string makes this inline code that happens to start a line.
  if (info.includes('`')) return null;
  return info.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
};

const isClosingFence = (line: string): boolean => /^ {0,3}```\s*$/.test(line);

export const parseContent = (text: string): Block[] => {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let pending: string[] = [];

  const flushText = (): void => {
    if (pending.length === 0) return;
    blocks.push({ kind: 'text', inline: inlineOf(pending.join('\n')) });
    pending = [];
  };

  // A scan that found no closing line proves there is none later either, so the next
  // opening line does not scan again — the whole pass stays linear however many open.
  let closersLeft = true;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const language = closersLeft ? openingFence(line) : null;
    if (language === null) {
      pending.push(line);
      index += 1;
      continue;
    }
    // Look forward for the closing line; with none, the fence is just text.
    let close = index + 1;
    while (close < lines.length && !isClosingFence(lines[close] ?? '')) close += 1;
    if (close >= lines.length) {
      closersLeft = false;
      pending.push(line);
      index += 1;
      continue;
    }
    flushText();
    blocks.push({ kind: 'fence', language, code: lines.slice(index + 1, close).join('\n') });
    index = close + 1;
  }
  flushText();
  return blocks;
};
