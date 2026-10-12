/**
 * A message body, read once at write time (`ARCHITECTURE.md` §8.1): the names it mentions, the
 * metadata it records, and why it is stored as typed when it is. The same reading for a send and
 * for an edit, so the two cannot come to disagree about what a body means (D-101, D-103).
 */
import { Value } from '@sinclair/typebox/value';
import { TextMetadata } from '@purlay/types';
import {
  metadataOf,
  readMarkdown,
  withoutFencedCode,
  type Engine,
  type Reading,
} from '@purlay/markdown';
import { AppError } from '../../platform/errors';
import { parseMentions } from './mentions';

export interface Body {
  /** The usernames it names with `@`, unresolved. */
  readonly names: readonly string[];
  readonly reading: Reading;
  readonly metadata: TextMetadata;
}

/**
 * Reads a body, or refuses one that broadcasts.
 *
 * `@here` and its kin are not a thing this product has (D-12), looked for only where the reader
 * sees prose: fenced code is blanked by the engine that renders it (D-101). Never a refusal for
 * complexity: a body too complex to format is still a message, shown as typed.
 */
export const readBody = (content: string, engine?: Engine): Body => {
  const mentions = parseMentions(withoutFencedCode(content, engine));
  if (mentions.broadcast.length > 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Mention people by name: there is no @here, @channel or @everyone.',
      details: { fields: { content: 'broadcast mentions are not available' } },
    });
  }
  const reading = readMarkdown(content, engine);
  const metadata = metadataOf(reading.tree);
  if (!Value.Check(TextMetadata, metadata)) {
    // The parser's own output outside the contract is a defect in this code, not in the message:
    // a 500, and the log names the fields that broke it — their paths, never their values.
    const paths = [...Value.Errors(TextMetadata, metadata)].map((error) => error.path);
    throw new Error(`metadata outside the contract at ${paths.join(', ')}`);
  }
  return { names: mentions.names, reading, metadata };
};
