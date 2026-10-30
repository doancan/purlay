/**
 * Links to messages, as cards under the words (D-217): a forwarded message, or a link to one pasted —
 * who wrote it, where, when, and the start of what they wrote, opening it where it lives.
 *
 * - **Only what this reader may see.** The card asks the server for the message as this reader
 *   (`GET /api/messages/:id`), which answers as every route that names a message does: a message in a
 *   channel they cannot see, deleted, or never sent is the one 404, and the card says only that it is not
 *   available to them — nothing of it. Forwarding a private message into a public channel shares a link,
 *   never its words.
 * - **A link of this workspace's own**: this origin, `/w/<slug>/c/<channel>?message=<id>` (or `?thread=`).
 *   Anything else stays a link.
 * - **A card is a decoration of a link that is already there**, as GitHub's are: until it arrives
 *   nothing is drawn. At most three, the rest stay links.
 */
import { useQuery } from '@tanstack/react-query';
import type { Message } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { keys } from '../../data/keys';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { messageHref } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { useWorkspaceIfAny } from '../shell/workspace';
import { authorOf } from '../messages/author';
import { useMessageText } from './github-event';

/** The most cards one message draws; past this the links are links. */
const CARDS_MAX = 3;

const LINK = /https?:\/\/[^\s<>()[\]]+/g;
const PATH = /^\/w\/([^/]+)\/c\/([^/?#]+)$/;

/** The messages the words link to, in this workspace on this origin, each once, at most three. */
export const linkedMessages = (
  content: string,
  origin: string,
  slug: string,
): readonly string[] => {
  const found: string[] = [];
  for (const [raw] of content.matchAll(LINK)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    const path = PATH.exec(url.pathname);
    if (path?.[1] !== slug) continue;
    const id = url.searchParams.get('message') ?? url.searchParams.get('thread');
    if (id === null || found.includes(id)) continue;
    found.push(id);
    if (found.length === CARDS_MAX) break;
  }
  return found;
};

const Card = ({
  messageId,
  slug,
}: {
  readonly messageId: string;
  readonly slug: string;
}): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const api = useApi();
  const { navigate } = useRoute();
  const textOf = useMessageText();
  const scope = useWorkspaceIfAny();
  const channels = useChannels(scope?.workspace.id ?? '', scope !== null).data;
  const read = useQuery({
    queryKey: keys.message(messageId),
    queryFn: ({ signal }) => api.message(messageId, signal),
    // A refusal is an answer: asking again would get the same one.
    retry: (count, failure) => !isApiError(failure) && count < 2,
    staleTime: 60_000,
  });
  if (read.isPending) return null;
  if (read.isError) {
    // Not available to this reader — or not there. Either way, nothing of it is shown.
    if (!isApiError(read.error) || read.error.status !== 404) return null;
    return (
      <p className="flex items-center gap-2 rounded-xl border-hairline border-border-subtle bg-surface-050 px-3 py-2 text-label text-ink-muted">
        <Icon name="lock" size="sm" />
        {t('messageCard.unavailable')}
      </p>
    );
  }
  const message: Message = read.data;
  const author = authorOf(message, t('user.erased'));
  const channel = channels?.find((each) => each.id === message.channelId);
  const where = channel?.name ?? null;
  return (
    <button
      type="button"
      onClick={() => {
        navigate(messageHref(slug, message.channelId, message.id));
      }}
      className="flex w-full max-w-feed flex-col gap-1 rounded-xl border-hairline border-l-marker border-border-subtle border-l-accent bg-surface-050 px-3 py-2 text-left transition-colors duration-hover ease-standard hover:bg-surface-200"
    >
      <span className="flex items-center gap-2 text-label">
        <Avatar size="sm" name={author.displayName} username={author.username} />
        <span className="truncate font-semibold text-ink">{author.displayName}</span>
        {where !== null && <span className="truncate text-ink-muted">#{where}</span>}
        <time
          dateTime={message.createdAt}
          className="ml-auto shrink-0 font-mono text-caption text-ink-muted"
        >
          {format.absolute(message.createdAt)}
        </time>
      </span>
      <span className="line-clamp-3 whitespace-pre-wrap text-body text-ink">{textOf(message)}</span>
    </button>
  );
};

export const MessageCards = ({
  content,
}: {
  readonly content: string;
}): React.JSX.Element | null => {
  const slug = useWorkspaceIfAny()?.workspace.slug ?? null;
  if (slug === null) return null;
  const ids = linkedMessages(content, window.location.origin, slug);
  if (ids.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {ids.map((id) => (
        <Card key={id} messageId={id} slug={slug} />
      ))}
    </div>
  );
};
