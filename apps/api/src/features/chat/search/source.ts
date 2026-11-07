/**
 * Chat's source of the workspace-wide find (D-285): the messages the caller may read that hold the words, as the search of
 * messages finds them, at most the find's few. It is `searchIn` itself, narrowed by the channels the caller can see before
 * anything is read (D-34), so the find shows no more than the search does and a private conversation reaches no answer.
 */
import type { FindHit, Message } from '@purlay/types';
import { oneLine } from '../../../platform/one-line';
import type { SearchSource } from '../../../platform/ports/search-source';
import { visibleChannelIds } from '../channels/guard';
import { searchIn } from './search';

const TITLE_MAX = 200;

const toHit = (message: Message): FindHit => ({
  id: message.id,
  title: oneLine(message.content, TITLE_MAX),
  excerpt: null,
  at: message.createdAt,
  target: { type: 'message', channelId: message.channelId, messageId: message.id },
});

export const chatMessagesSource: SearchSource = {
  id: 'messages',
  search: async ({ database, context, query, limit }) => {
    const page = await searchIn(database, context, await visibleChannelIds(database, context), {
      q: query,
      limit,
    });
    return page.data.map(toHit);
  },
};
