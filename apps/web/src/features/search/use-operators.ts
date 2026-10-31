/**
 * The search operators (D-224) over what this client already holds — the channels it lists, the
 * workspace's people, who is signed in and the viewer's day — for each place a search is typed: the
 * search screen, `/search` and the palette.
 */
import { useMemo } from 'react';
import { SEARCH_QUERY_MAX, SEARCH_QUERY_MIN } from '@purlay/types';
import { useChannels, useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import type { Translate } from '../../i18n/types';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import {
  asTyped,
  liftOperators,
  unreadOperators,
  type Directory,
  type SearchProblem,
  type SearchState,
  type UnreadOperator,
} from './operators';

const EVERYWHERE: SearchState = { words: '', channelId: null, authorId: null, filters: {} };

export interface SearchOperators {
  /** What typed text asks for, over what was already chosen (`EVERYWHERE` when nothing was). */
  readonly lift: (text: string, base?: SearchState) => SearchState;
  /** The words as the field shows them. */
  readonly typed: (words: string) => string;
  /** What the words hold that could not be read; nothing until the channels and people are known. */
  readonly unread: (words: string) => readonly UnreadOperator[];
}

export const useSearchOperators = (): SearchOperators => {
  const { workspace } = useWorkspace();
  const { user } = useSession();
  const { format } = useI18n();
  const channels = useChannels(workspace.id).data;
  const members = useMembers(workspace.id).data;
  return useMemo(() => {
    const directory: Directory = {
      channels: channels ?? [],
      members: members ?? [],
      meId: user.id,
      dayStart: format.dayStart,
    };
    // A name not found in a list still on its way is not a name nobody has.
    const known = channels !== undefined && members !== undefined;
    return {
      lift: (text, base = EVERYWHERE) => liftOperators(text, base, directory),
      typed: (words) => asTyped(words, directory),
      unread: (words) => (known ? unreadOperators(words, directory) : []),
    };
  }, [channels, members, user.id, format]);
};

/** Why a search was not asked, as the field (or the composer, for `/search`) says it. */
export const problemText = (t: Translate, problem: SearchProblem): string => {
  switch (problem) {
    case 'tooShort':
      return t('search.tooShort', { min: String(SEARCH_QUERY_MIN) });
    case 'tooLong':
      return t('search.tooLong', { max: String(SEARCH_QUERY_MAX) });
    case 'range':
      return t('search.rangeError');
  }
};
