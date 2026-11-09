import { describe, expect, test } from 'bun:test';
import type { EntitlementCatalogue } from './apply';
import { planEdition, readEditionFile, type EditionFile } from './edition';

const NOW = new Date('2026-11-07T12:00:00Z');
const catalogue: EntitlementCatalogue = {
  mode: 'managed',
  carried: [
    { id: 'chat', requires: [], entitlement: 'always' },
    { id: 'issues', requires: [] },
    { id: 'tasks', requires: ['issues'] },
  ],
};
const file = (over: Partial<EditionFile> = {}): EditionFile => ({
  editions: { team: ['chat', 'issues'], business: ['chat', 'issues', 'tasks'] },
  workspaces: {
    acme: { edition: 'team' },
    beta: { edition: 'business', validUntil: '2027-01-01T00:00:00Z' },
  },
  ...over,
});
const ids = new Map([
  ['acme', 'w-acme'],
  ['beta', 'w-beta'],
]);

describe('reading an edition file', () => {
  test('accepts the documented shape and names what is wrong otherwise', () => {
    expect(readEditionFile(JSON.stringify(file())).problems).toEqual([]);
    expect(readEditionFile('{').problems).toEqual(['it is not JSON']);
  });

  test('refuses a key written twice in one object, whichever it is, since the parser keeps the last and says nothing', () => {
    const twice = (text: string): string[] => readEditionFile(text).problems;
    const base = '"editions":{"a":["chat"]}';
    expect(twice(`{${base},"workspaces":{"acme":{"edition":"a"},"acme":{"edition":"a"}}}`)).toEqual(
      [
        '"acme" is written more than once in one object, so which entry applies is not for a parser to guess',
      ],
    );
    // An escape is the same key; a repeat in an object of another place is found; two objects that each have a key are not a repeat.
    expect(
      twice(`{${base},"workspaces":{"ac\\u006de":{"edition":"a"},"acme":{"edition":"a"}}}`),
    ).toHaveLength(1);
    expect(twice('{"editions":{"a":[],"a":[]},"workspaces":{}}')).toHaveLength(1);
    expect(twice(`{${base},"workspaces":{"x":{"edition":"a"},"y":{"edition":"a"}}}`)).toEqual([]);
    // A string that looks like syntax is a string.
    expect(
      twice(
        `{"editions":{"a, \\"b\\": {":["chat"]},"workspaces":{"w":{"edition":"a, \\"b\\": {"}}}`,
      ),
    ).toEqual([]);
    for (const bad of [
      {},
      { editions: {}, workspaces: {}, extra: 1 },
      { editions: { team: ['Chat'] }, workspaces: {} },
      { editions: { team: [] }, workspaces: { acme: {} } },
      { editions: { team: [] }, workspaces: { acme: { edition: 'team', validUntil: 'soon' } } },
      { editions: { team: [] }, workspaces: { acme: { edition: 'team', discount: 1 } } },
    ]) {
      expect(readEditionFile(JSON.stringify(bad)).problems.length).toBeGreaterThan(0);
    }
  });
});

describe('what an edition file asks for', () => {
  test('is each listed workspace given the modules of its edition and none of the others, the end on the grants only', () => {
    const { writes, problems } = planEdition(file(), catalogue, ids, NOW);
    expect(problems).toEqual([]);
    expect(
      writes.map(({ workspaceId, module, state }) => `${workspaceId} ${module} ${state}`),
    ).toEqual(['w-acme issues on', 'w-acme tasks off', 'w-beta issues on', 'w-beta tasks on']);
    expect(
      writes
        .filter(({ validUntil }) => validUntil !== undefined)
        .map(({ workspaceId }) => workspaceId),
    ).toEqual(['w-beta', 'w-beta']);
  });

  test('never writes chat, which no workspace is granted, whether an edition lists it or not', () => {
    const { writes } = planEdition(
      file({ editions: { team: [], business: ['chat'] } }),
      catalogue,
      ids,
      NOW,
    );
    expect(writes.some(({ module }) => module === 'chat')).toBe(false);
  });

  test('refuses, with every reason, a module the build lacks, an edition not defined, a workspace not there and an end that has passed', () => {
    const { writes, problems } = planEdition(
      {
        editions: { team: ['chat', 'mail'] },
        workspaces: {
          acme: { edition: 'gold' },
          nowhere: { edition: 'team' },
          beta: { edition: 'team', validUntil: '2020-01-01T00:00:00Z' },
        },
      },
      catalogue,
      ids,
      NOW,
    );
    expect(problems).toEqual([
      'edition "team" lists "mail", which this build does not carry',
      'workspace "acme" names the edition "gold", which the file does not define',
      'there is no workspace "nowhere"',
      'workspace "beta": validUntil has passed',
    ]);
    // A file with a problem plans what it can, and the command applies none of it.
    expect(writes.length).toBeGreaterThan(0);
  });
});
