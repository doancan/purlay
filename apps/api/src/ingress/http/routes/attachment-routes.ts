/**
 * Files: the upload of an attachment, the proxy for an external image, and an attachment's download and removal.
 */
import { externalFetch } from '../../../modules/images/proxy';
import { serveExternalImage } from '../images';
import { receiveUpload } from '../uploads';
import { discardAttachment, downloadAttachment } from '../attachments';
import { Elysia, type AnyElysia } from 'elysia';
import { sendingOf, type RouteContext } from '../route-context';

export const attachmentRoutes = (context: RouteContext): AnyElysia => {
  const { dependencies } = context;
  const sending = sendingOf(context);
  // Uploads being read on this node, against `UPLOADS_AT_ONCE`.
  const uploading = { count: 0 };

  return new Elysia()
    .post(
      '/api/workspaces/:workspaceId/uploads',
      async ({ request, params, set }) => {
        const { attachment, created } = await receiveUpload(
          { ...sending, storage: dependencies.storage, log: dependencies.log, inFlight: uploading },
          request,
          params.workspaceId,
        );
        set.status = created ? 201 : 200;
        return attachment;
      },
      // The body is the file, read by the handler after the session and the membership (D-109 §3).
      { parse: 'none' },
    )
    .get('/api/images', async ({ request, set }) => {
      const { body, headers } = await serveExternalImage(
        { ...dependencies, externalFetch: dependencies.externalFetch ?? externalFetch },
        request,
      );
      Object.assign(set.headers, headers);
      return body;
    })
    .get('/api/attachments/:attachmentId', async ({ request, params, set }) => {
      const download = await downloadAttachment(
        dependencies,
        request,
        params.attachmentId,
        'original',
      );
      Object.assign(set.headers, download.headers);
      set.status = download.status;
      return download.status === 304 ? null : download.body;
    })
    .get('/api/attachments/:attachmentId/thumbnail', async ({ request, params, set }) => {
      const download = await downloadAttachment(
        dependencies,
        request,
        params.attachmentId,
        'thumbnail',
      );
      Object.assign(set.headers, download.headers);
      set.status = download.status;
      return download.status === 304 ? null : download.body;
    })
    .delete('/api/attachments/:attachmentId', async ({ request, params, set }) => {
      await discardAttachment(
        { ...sending, storage: dependencies.storage, log: dependencies.log },
        request,
        params.attachmentId,
      );
      set.status = 204;
      return null;
    });
};
