/**
 * The reaction endpoints (`API.md` §5): `PUT` and `DELETE` on
 * `/api/messages/:messageId/reactions/:emoji`.
 *
 * The emoji is a path segment, so the framework has already percent-decoded it;
 * it is then checked against the contract's `emoji` format like any other input —
 * one emoji, not text — before anything reads it.
 */
import { Type } from '@sinclair/typebox';
import type { Executor } from '@purlay/db';
import { Reaction, type ReactionsResponse } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { setReaction, type ReactionDependencies } from '../../modules/reactions/reactions';
import { requireSession } from './session';
import { validated } from './validate';

export interface ReactionRouteDependencies extends ReactionDependencies {
  readonly database: Executor;
  readonly clock: Clock;
}

const EmojiParameter = Type.Object({ emoji: Reaction.properties.emoji });

export const changeReaction = async (
  dependencies: ReactionRouteDependencies,
  request: Request,
  messageId: string,
  emoji: string,
  present: boolean,
): Promise<ReactionsResponse> => {
  const caller = await requireSession(dependencies.database, dependencies.clock, request);
  const parameter = validated(EmojiParameter, { emoji });
  return await setReaction(dependencies, caller, messageId, parameter.emoji, present);
};
