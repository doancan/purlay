/** __PASCAL__ (`MODULES.md` §11): a workspace's rows, each a title. */
import { Type, type Static } from '@sinclair/typebox';
import type { FactDeclaration } from './fact-declaration';
import { FromClient, Timestamp, Uuid } from './models';

/** The longest title: one line, as a list shows it. */
export const __UPPER___TITLE_MAX = 200;

export const __PASCAL__Item = Type.Object({ id: Uuid, title: Type.String(), createdAt: Timestamp });
export type __PASCAL__Item = Static<typeof __PASCAL__Item>;

/** `GET /api/workspaces/:workspaceId/__ID__` — newest first. */
export const __PASCAL__ItemList = Type.Array(__PASCAL__Item);

/** `POST /api/workspaces/:workspaceId/__ID__` — a new row. */
export const Create__PASCAL__ItemRequest = FromClient({
  title: Type.String({ minLength: 1, maxLength: __UPPER___TITLE_MAX, format: 'name' }),
});
export type Create__PASCAL__ItemRequest = Static<typeof Create__PASCAL__ItemRequest>;

/**
 * The facts __ID__ publishes (`docs/MODULE-GUIDE.md` §5), joined to `FACTS` in `facts.ts` already. Declare each with
 * `defineFact` from `./fact-declaration`: `./facts` imports this file, so a value imported from it here is a cycle.
 */
export const __UPPER___FACTS: readonly FactDeclaration[] = [];
