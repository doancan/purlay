import { describe, expect, test } from 'bun:test';
import type { WorkspaceMember } from '@purlay/types';
import { ALICE, BOB, IDS, ME, WHEN, aChannel, aUser, NO_PROFILE } from '../../testing/fixtures';
import { candidatesFor } from './mention-candidates';

const CAROL = aUser('carol', '00000000-0000-4000-8000-0000000000e4');
const FORMER = aUser('former', '00000000-0000-4000-8000-0000000000e5');
const members: WorkspaceMember[] = [ME, ALICE, BOB, CAROL].map((user) => ({
  user,
  role: 'member',
  joinedAt: WHEN,
  profile: NO_PROFILE,
}));
const names = (people: readonly { readonly username: string }[]): string[] =>
  people.map((person) => person.username);

describe('who the @ list may offer', () => {
  test('in a public channel, everybody in the workspace but the writer', () => {
    expect(names(candidatesFor(aChannel(IDS.api, 'api'), members, undefined, ME.id))).toEqual([
      'alice',
      'bob',
      'carol',
    ]);
  });

  test('in a direct message, the other person only; in a note to self, nobody', () => {
    const dm = aChannel(IDS.dm, null, { type: 'direct_message', peer: ALICE });
    expect(names(candidatesFor(dm, members, undefined, ME.id))).toEqual(['alice']);
    const self = aChannel(IDS.dm, null, { type: 'direct_message', peer: ME });
    expect(candidatesFor(self, members, undefined, ME.id)).toEqual([]);
  });

  test('in a group, its people still in the workspace (D-127)', () => {
    const group = aChannel(IDS.dm, null, { type: 'direct_message', peers: [ALICE, BOB] });
    expect(names(candidatesFor(group, members, undefined, ME.id))).toEqual(['alice', 'bob']);
    const gone = aChannel(IDS.dm, null, {
      type: 'direct_message',
      peers: [ALICE, { ...BOB, id: '00000000-0000-4000-8000-0000000000ff' }],
    });
    expect(names(candidatesFor(gone, members, undefined, ME.id))).toEqual(['alice']);
  });

  test('in a private channel, its members now: not who left it, though they wrote there (#500)', () => {
    const security = aChannel(IDS.incidents, 'security', { type: 'private' });
    // Bob and Carol are in it; Alice is in the workspace but not the channel; FORMER is in neither.
    expect(names(candidatesFor(security, members, [ME, BOB, CAROL, FORMER], ME.id))).toEqual([
      'bob',
      'carol',
    ]);
    // Alice wrote there once and has left: a mention of her would reach nobody, so she is not offered.
    expect(names(candidatesFor(security, members, [ME, BOB], ME.id))).toEqual(['bob']);
  });

  test('in a private channel whose members are not read yet, nobody rather than a guess', () => {
    const security = aChannel(IDS.incidents, 'security', { type: 'private' });
    expect(candidatesFor(security, members, undefined, ME.id)).toEqual([]);
  });

  test('before the channel is known, nobody', () => {
    expect(candidatesFor(undefined, members, undefined, ME.id)).toEqual([]);
  });
});
