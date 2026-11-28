/**
 * Where an attachment's bytes are read, for an `<a href>` or an `<img src>`: the API's own path, with the
 * session cookie like everything else. The endpoints and every screen that links to a file or draws an image name
 * it here, so the path is written once.
 */
import { at } from './endpoints/request';

export const attachmentUrl = (attachmentId: string): string =>
  `/api/attachments/${at(attachmentId)}`;

/** The reduced picture the feed and the file lists draw before the original is opened. */
export const attachmentThumbnailUrl = (attachmentId: string): string =>
  `${attachmentUrl(attachmentId)}/thumbnail`;
