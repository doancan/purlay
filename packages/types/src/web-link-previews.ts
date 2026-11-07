/** Public-web metadata decorates an existing message link; it never replaces that link. */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient } from './models';

export const WEB_LINKS_PER_MESSAGE_MAX = 2;
export const WEB_LINK_URL_MAX = 2048;
export const WEB_LINK_TITLE_MAX = 200;
export const WEB_LINK_DESCRIPTION_MAX = 400;

const Address = Type.String({ format: 'uri', pattern: '^https://', maxLength: WEB_LINK_URL_MAX });
export const WebLinkPreviewRequest = FromClient({ url: Address });
export type WebLinkPreviewRequest = Static<typeof WebLinkPreviewRequest>;

export const WebLinkPreview = Type.Object({
  title: Type.String({ format: 'name', minLength: 1, maxLength: WEB_LINK_TITLE_MAX }),
  description: Type.Union([
    Type.Null(),
    Type.String({ format: 'name', minLength: 1, maxLength: WEB_LINK_DESCRIPTION_MAX }),
  ]),
  imageUrl: Type.Union([Type.Null(), Address]),
});
export type WebLinkPreview = Static<typeof WebLinkPreview>;

export const WebLinkPreviewResponse = Type.Union([Type.Null(), WebLinkPreview]);
export type WebLinkPreviewResponse = Static<typeof WebLinkPreviewResponse>;
