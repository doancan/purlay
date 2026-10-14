/**
 * Who a message is by (D-134 §6): a person's is theirs; a message nobody wrote is GitHub's, nobody's
 * own, and stands alone in a run of messages.
 */
import { describe, expect, test } from 'bun:test';
import { ALICE, ME } from '../../testing/fixtures';
import { erasedPerson } from '@purlay/types';
import { authorOf, isMine, nameOf, sameAuthor } from './author';

const event = { sender: null };

describe('who a message is by', () => {
  test('a person’s is theirs; an event is GitHub’s', () => {
    expect(authorOf({ sender: ALICE }, 'Deleted user')).toEqual({
      displayName: ALICE.displayName,
      username: ALICE.username,
    });
    expect(authorOf(event, 'Deleted user')).toEqual({ displayName: 'GitHub', username: 'github' });
  });

  test('an erased person is “deleted user”, in the reader’s words, by name and by handle (D-139 §5)', () => {
    const gone = erasedPerson(ALICE.id);
    expect(authorOf({ sender: gone }, 'Silinmiş kullanıcı')).toEqual({
      displayName: 'Silinmiş kullanıcı',
      username: 'Silinmiş kullanıcı',
    });
    expect(nameOf(gone, 'Silinmiş kullanıcı')).toBe('Silinmiş kullanıcı');
    expect(nameOf(ALICE, 'Silinmiş kullanıcı')).toBe(ALICE.displayName);
  });

  test('yours only when you wrote it: never an event, whoever asks', () => {
    expect(isMine({ sender: ME }, ME.id)).toBe(true);
    expect(isMine({ sender: ALICE }, ME.id)).toBe(false);
    expect(isMine(event, ME.id)).toBe(false);
    expect(isMine(event, undefined)).toBe(false);
  });

  test('one person’s messages run together; events never do', () => {
    expect(sameAuthor({ sender: ALICE }, { sender: ALICE })).toBe(true);
    expect(sameAuthor({ sender: ALICE }, { sender: ME })).toBe(false);
    expect(sameAuthor(event, event)).toBe(false);
    expect(sameAuthor(event, { sender: ALICE })).toBe(false);
  });
});
