/**
 * The reaction endpoints (`API.md` §5): `PUT` and `DELETE` on
 * `/api/messages/:messageId/reactions/:emoji`.
 *
 * The emoji is a path segment, so the framework has already percent-decoded it;
 * it is then checked against the contract's `emoji` format like any other input —
 * one emoji, not text — before anything reads it.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import { Type } from '@sinclair/typebox';
import { Reaction, type ReactionsResponse } from '@purlay/types';
import { setReaction, type ReactionDependencies } from '../reactions/reactions';
import { requireSession } from '../../../ingress/http/session';
import { validated } from '../../../ingress/http/validate';

/** What the module's routes are handed, as far as a reaction needs it: who is calling, the database and the clock. */
interface ReactionRouteDependencies
  extends ReactionDependencies, Pick<ModuleRouteDependencies, 'auth' | 'database' | 'clock'> {}

const EmojiParameter = Type.Object({ emoji: Reaction.properties.emoji });

const changeReaction = async (
  dependencies: ReactionRouteDependencies,
  request: Request,
  messageId: string,
  emoji: string,
  present: boolean,
): Promise<ReactionsResponse> => {
  const caller = await requireSession(dependencies.auth, request);
  const parameter = validated(EmojiParameter, { emoji });
  return await setReaction(dependencies, caller, messageId, parameter.emoji, present);
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const reactionRoutes = (context: ModuleRouteDependencies): AnyElysia =>
  new Elysia()
    .put(
      '/api/messages/:messageId/reactions/:emoji',
      async ({ request, params }) =>
        await changeReaction(context, request, params.messageId, params.emoji, true),
    )
    .delete(
      '/api/messages/:messageId/reactions/:emoji',
      async ({ request, params }) =>
        await changeReaction(context, request, params.messageId, params.emoji, false),
    );
