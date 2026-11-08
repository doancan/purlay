/**
 * How a module's route tells the build a fact (`MODULES.md` §4, D-283 §2, D-288): `publishFact` of the outbox, with the
 * publisher fixed. The core binds one for each module, so a handler names the fact and the payload and cannot name the module it
 * speaks as: a fact is published as the module whose route this is, or `publishFact` refuses it.
 *
 * Like the inbox's sink it runs **inside the caller's own transaction** (`atomicallyOn(database)`), so the fact exists exactly
 * when what it reports does; a pool is not accepted.
 */
import type { Static } from '@sinclair/typebox';
import type { Transaction } from '@purlay/db';
import type { FactDeclaration } from '@purlay/types';
import { publishFact, type FactPublishContext } from '../outbox';
import { assertMinted, type WorkspaceContext } from '../tenancy';

export type FactPublisher = <Fact extends FactDeclaration>(
  transaction: Transaction,
  context: WorkspaceContext,
  fact: Fact,
  payload: Static<Fact['schema']>,
) => Promise<void>;

/** What the application knows once, and every module's publisher shares: everything of a publish but the workspace and the publisher. */
type SharedFactContext = Omit<FactPublishContext, 'workspaceId' | 'producer'>;

export const factPublisherOf =
  (producer: string, shared: SharedFactContext): FactPublisher =>
  async (transaction, context, fact, payload) => {
    assertMinted(context);
    await publishFact(
      transaction,
      { ...shared, workspaceId: context.workspaceId, producer },
      fact,
      payload,
    );
  };
