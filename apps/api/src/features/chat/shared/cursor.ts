/** Opaque compound keyset, bound to the current reader/workspace and every filter, not to a surviving row. */
import { createHash } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Uuid, type SharedQuery } from '@purlay/types';
import { AppError } from '../../../platform/errors';
import type { WorkspaceContext } from '../../../platform/tenancy';

const Digest = Type.String({ pattern: '^[0-9a-f]{64}$' });
const Cursor = Type.Object(
  { v: Type.Literal(1), message: Uuid, key: Type.Union([Uuid, Digest]), scope: Digest },
  { additionalProperties: false },
);
type Cursor = Static<typeof Cursor>;
const invalid = (): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message: 'This page does not belong to these filters.',
    details: { fields: { before: 'Choose the filters again and start from the newest items.' } },
  });

const scopeOf = (context: WorkspaceContext, query: SharedQuery): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        context.workspaceId,
        context.userId,
        query.view,
        query.q?.trim() ?? '',
        query.channelId ?? null,
        query.senderId ?? null,
        query.type ?? null,
        query.since ?? null,
        query.until ?? null,
      ]),
    )
    .digest('hex');

export const sharedCursor = (
  context: WorkspaceContext,
  query: SharedQuery,
): {
  readonly before: { readonly message: string; readonly key: string } | undefined;
  readonly next: (message: string, key: string) => string;
} => {
  const scope = scopeOf(context, query);
  let before: Cursor | undefined;
  if (query.before !== undefined) {
    let parsed: unknown;
    try {
      const bytes = Buffer.from(query.before, 'base64url');
      if (bytes.toString('base64url') !== query.before) throw invalid();
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw invalid();
    }
    if (
      !Value.Check(Cursor, parsed) ||
      parsed.scope !== scope ||
      !(query.view === 'files' ? Value.Check(Uuid, parsed.key) : Value.Check(Digest, parsed.key))
    )
      throw invalid();
    before = parsed;
  }
  return {
    before,
    next: (message, key): string =>
      Buffer.from(JSON.stringify({ v: 1, message, key, scope })).toString('base64url'),
  };
};
