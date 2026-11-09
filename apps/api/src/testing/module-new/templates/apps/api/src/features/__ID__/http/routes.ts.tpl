/** The routes of __ID__: the plugin `createApp` uses for this module, at the paths its manifest lists. */
import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import type { __PASCAL__Db } from '../schema';
import { list__PASCAL__, post__PASCAL__ } from './handlers';

export const __CAMEL__Routes = (context: ModuleRouteDependencies<__PASCAL__Db>): AnyElysia =>
  new Elysia()
    .get(
      '/api/workspaces/:workspaceId/__ID__',
      async ({ request, params }) => await list__PASCAL__(context, request, params.workspaceId),
    )
    .post('/api/workspaces/:workspaceId/__ID__', async ({ request, params, body, set }) => {
      const created = await post__PASCAL__(context, request, params.workspaceId, body);
      set.status = 201;
      return created;
    });
