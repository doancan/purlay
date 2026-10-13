import { describe, expect, test } from 'bun:test';
import type { WorkspaceMember } from '@purlay/types';
import { ALICE, BOB, IDS, ME, WHEN, aChannel, aMessage, aUser } from '../../testing/fixtures';
import { candidatesFor } from './mention-candidates';

const CAROL = aUser('carol', '00000000-0000-4000-8000-0000000000e4');
const FORMER = aUser('former', '00000000-0000-4000-8000-0000000000e5');
const members: WorkspaceMember[] = [ME, ALICE, BOB, CAROL].map((user) => ({
  user,
  role: 'member',
  joinedAt: WHEN,
}));
const names = (people: readonly { readonly username: string }[]): string[] =>
  people.map((person) => person.username);

describe('who the @ list may offer', () => {
  test('in a public channel, everybody in the workspace but the writer', () => {
    expect(names(candidatesFor(aChannel(IDS.api, 'api'), members, [], ME.id))).toEqual([
      'alice',
      'bob',
      'carol',
    ]);
  });

  test('in a direct message, the other person only; in a note to self, nobody', () => {
    const dm = aChannel(IDS.dm, null, { type: 'direct_message', peer: ALICE });
    expect(names(candidatesFor(dm, members, [], ME.id))).toEqual(['alice']);
    const self = aChannel(IDS.dm, null, { type: 'direct_message', peer: ME });
    expect(candidatesFor(self, members, [], ME.id)).toEqual([]);
  });

  test('in a private channel, only who wrote or was named there and is still in the workspace', () => {
    const security = aChannel(IDS.incidents, 'security', { type: 'private' });
    const loaded = [
      aMessage(1, { channelId: IDS.incidents, sender: BOB }),
      aMessage(2, { channelId: IDS.incidents, sender: ME, mentions: [CAROL.id] }),
      // Somebody since removed from the workspace wrote here once: not offered.
      aMessage(3, { channelId: IDS.incidents, sender: FORMER }),
    ];
    expect(names(candidatesFor(security, members, loaded, ME.id))).toEqual(['bob', 'carol']);
    // Alice is in the workspace and wrote nowhere here: a private channel does not offer her.
    expect(names(candidatesFor(security, members, [], ME.id))).toEqual([]);
  });

  test('before the channel is known, nobody', () => {
    expect(candidatesFor(undefined, members, [], ME.id)).toEqual([]);
  });
});
