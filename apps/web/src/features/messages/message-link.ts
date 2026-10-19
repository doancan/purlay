/**
 * A link to one message (D-149): what "Copy link" puts on the clipboard, and how long the message a
 * link opened stays marked.
 *
 * The address is `?message=` on the channel's own (`router/routes.ts`), made whole with the page's
 * origin so it can be pasted anywhere — another chat, a pull request, an issue. Opening it is the
 * channel's: the feed around the message, scrolled to it, marked and focused.
 */
import { useCallback } from 'react';
import type { Message } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { messageHref } from '../../router/routes';
import { useToast } from '../../ui/toast';
import { useContentPorts } from '../content/content-ports';
import { useWorkspaceIfAny } from '../shell/workspace';

/** How long the message a link opened is marked, before the tint fades. */
export const LANDED_MS = 2_000;

/** The whole address of a message, from the origin the page is served at. */
export const messageUrl = (
  origin: string,
  slug: string,
  message: Pick<Message, 'id' | 'channelId'>,
): string => new URL(messageHref(slug, message.channelId, message.id), origin).href;

/**
 * Copies a message's link and says so in a toast, or says that it could not: the clipboard refuses
 * outside a secure context or without permission, and a copy that silently did nothing would leave
 * the person pasting whatever they copied before. Null outside a workspace, where a message has no
 * address to copy.
 */
export const useCopyMessageLink = (): ((message: Message) => void) | null => {
  const { t } = useI18n();
  const slug = useWorkspaceIfAny()?.workspace.slug ?? null;
  const { copy } = useContentPorts();
  const { show } = useToast();
  const copyLink = useCallback(
    (message: Message): void => {
      if (slug === null) return;
      copy(messageUrl(window.location.origin, slug, message)).then(
        () => {
          show({ message: t('message.linkCopied') });
        },
        () => {
          show({ message: t('failure.copy') });
        },
      );
    },
    [copy, slug, show, t],
  );
  return slug === null ? null : copyLink;
};
