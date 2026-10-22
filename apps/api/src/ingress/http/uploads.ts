/**
 * `POST /api/workspaces/:workspaceId/uploads?id=&name=` (D-109 §3): the file's bytes, nothing else.
 *
 * The edge has already held the request to `application/octet-stream` and its `Content-Length`; the
 * route reads no body itself (`parse: 'none'`). Here the session, the membership and the query are
 * checked **before a byte is read**, so 25 MiB is never taken from somebody who is not let in, and
 * then the body is read once and handed to the module.
 */
import type { Auth } from '../../modules/auth/better-auth';
import { UploadQuery, type Attachment } from '@purlay/types';
import { storeUpload, type UploadDependencies } from '../../modules/attachments/uploads';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import type { Executor } from '@purlay/db';
import { requireSession } from './session';
import { validated } from './validate';

/** How many uploads one node holds in memory at once: each may be 25 MiB (D-109 §2). */
export const UPLOADS_AT_ONCE = 4;

export interface UploadRouteDependencies extends UploadDependencies {
  /** Who is calling: every session is resolved through it (`sessions.ts`, D-179). */
  readonly auth: Auth;
  readonly database: Executor;
  readonly clock: Clock;
  /** This node's count of uploads being read: the gate, held by the app. */
  readonly inFlight: { count: number };
}

export const receiveUpload = async (
  dependencies: UploadRouteDependencies,
  request: Request,
  workspaceId: string,
): Promise<{ readonly attachment: Attachment; readonly created: boolean }> => {
  const { database, inFlight } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const query = validated(UploadQuery, Object.fromEntries(new URL(request.url).searchParams));
  if (inFlight.count >= UPLOADS_AT_ONCE) {
    throw new AppError({
      code: 'RATE_LIMITED',
      message: 'This server is taking as many uploads as it can. Try again in a moment.',
    });
  }
  inFlight.count += 1;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    return await storeUpload(dependencies, context, { id: query.id, name: query.name, bytes });
  } finally {
    inFlight.count -= 1;
  }
};
