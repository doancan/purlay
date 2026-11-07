/** A preview is requested for a currently readable message and its selected rendered link. */
import { Elysia, type AnyElysia } from 'elysia';
import { WebLinkPreviewRequest } from '@purlay/types';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import { requireSession } from '../../../ingress/http/session';
import { validated } from '../../../ingress/http/validate';
import type { ExternalFetch } from '../../../modules/images/proxy';
import { requireMessageById } from '../channels/guard';
import { externalPageFetch, webPreviews } from '../integrations/web-previews';

export type PreviewRouteDependencies = ModuleRouteDependencies & {
  readonly previewFetch?: ExternalFetch;
};

export const webPreviewRoutes = (context: PreviewRouteDependencies): AnyElysia => {
  const read = webPreviews({
    ...context,
    fetch: context.previewFetch ?? externalPageFetch,
    appUrl: context.config.APP_URL,
  });
  return new Elysia().post(
    '/api/messages/:messageId/link-preview',
    async ({ request, params, body }) => {
      const { userId } = await requireSession(context.auth, request);
      const found = await requireMessageById(context.database, userId, params.messageId);
      const input = validated(WebLinkPreviewRequest, body);
      // Elysia treats a bare null as an empty body; the nullable contract promises JSON null.
      return Response.json(await read(found, input.url));
    },
  );
};
