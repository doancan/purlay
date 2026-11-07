/** Bounded HTML metadata, read without a DOM, scripts, styles or subresource requests. */
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { decodeHTML, decodeHTMLAttribute } from 'entities/decode';
import {
  FORBIDDEN_IN_NAME,
  WEB_LINK_DESCRIPTION_MAX,
  WEB_LINK_TITLE_MAX,
  WEB_LINK_URL_MAX,
  type WebLinkPreview,
} from '@purlay/types';
import { externalImageAddress } from '../../../modules/images/proxy';

export const WEB_PREVIEW_BYTES_MAX = 256 * 1024;
const UNSAFE_TEXT = new RegExp(FORBIDDEN_IN_NAME.source, 'g');
const VisibleText = Type.String({ format: 'name' });

const plain = (decoded: string, limit: number): string | null => {
  const text = decoded.replace(/\s+/g, ' ').replace(UNSAFE_TEXT, '').trim();
  // A UTF-16 bound must not leave half an emoji as the last character.
  const clipped = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
  return Value.Check(VisibleText, clipped) ? clipped : null;
};

const imageAddress = (raw: string, page: URL): string | null => {
  const decoded = decodeHTMLAttribute(raw).trim();
  if (decoded === '') return null;
  let address: URL;
  try {
    address = new URL(decoded, page);
  } catch {
    return null;
  }
  return address.href.length <= WEB_LINK_URL_MAX && externalImageAddress(address.href) !== null
    ? address.href
    : null;
};

export const previewHtml = async (bytes: Uint8Array, page: URL): Promise<WebLinkPreview | null> => {
  if (bytes.byteLength > WEB_PREVIEW_BYTES_MAX) return null;
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
  let titleIndex = 0;
  let titleText = '';
  const metadata: Record<
    'ogTitle' | 'ogDescription' | 'description' | 'image' | 'secureImage',
    string | null
  > = {
    ogTitle: null,
    ogDescription: null,
    description: null,
    image: null,
    secureImage: null,
  };
  await new HTMLRewriter()
    .on('title', {
      element(): void {
        titleIndex += 1;
      },
      text(chunk): void {
        if (titleIndex === 1) titleText += chunk.text;
      },
    })
    .on('meta', {
      element(element): void {
        const value = element.getAttribute('content');
        if (value === null) return;
        for (const raw of [element.getAttribute('property'), element.getAttribute('name')]) {
          if (raw === null) continue;
          const key = decodeHTMLAttribute(raw).trim().toLowerCase();
          switch (key) {
            case 'og:title':
              metadata.ogTitle ??= plain(decodeHTMLAttribute(value), WEB_LINK_TITLE_MAX);
              break;
            case 'og:description':
              metadata.ogDescription ??= plain(
                decodeHTMLAttribute(value),
                WEB_LINK_DESCRIPTION_MAX,
              );
              break;
            case 'description':
              metadata.description ??= plain(decodeHTMLAttribute(value), WEB_LINK_DESCRIPTION_MAX);
              break;
            case 'og:image':
              metadata.image ??= imageAddress(value, page);
              break;
            case 'og:image:secure_url':
              metadata.secureImage ??= imageAddress(value, page);
              break;
          }
        }
      },
    })
    .transform(new Response(html))
    .text();
  const title = metadata.ogTitle ?? plain(decodeHTML(titleText), WEB_LINK_TITLE_MAX);
  return title === null
    ? null
    : {
        title,
        description: metadata.ogDescription ?? metadata.description,
        imageUrl: metadata.secureImage ?? metadata.image,
      };
};
