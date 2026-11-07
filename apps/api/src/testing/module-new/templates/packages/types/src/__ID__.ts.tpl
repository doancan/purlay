/** __PASCAL__ (`MODULES.md` §11): a workspace's rows, each a title. */
import { Type, type Static } from '@sinclair/typebox';
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
