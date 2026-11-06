/**
 * Chat is moved behind its handle in steps (D-271, `MODULES.md` §10, step 9): a file takes `ChatDb` and `ChatTx` from
 * `features/chat/schema.ts` in place of the whole database's executor, and a query in it over a table that is not chat's or
 * one it reads does not compile. The lint cannot say which files are done (it is per feature and chat is exempt until the
 * last), so this list is the ratchet: the files that still import `Executor`, `Transaction`, `Database` or `DB` from
 * `@purlay/db`. **It may only shrink**: a file that is behind the handle and still listed fails, and so does one not listed
 * that is not. The change that empties it deletes it, takes chat out of `NOT_YET_BEHIND_THEIR_HANDLE` and turns the lint on.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { shown, sourcesOf } from './testing/module-sources';
import { wholeDatabaseImports } from './testing/module-tables';

const NOT_YET_BEHIND_THE_HANDLE: readonly string[] = [
  'features/chat/channels/channels.ts',
  'features/chat/channels/departures.ts',
  'features/chat/channels/direct-messages.ts',
  'features/chat/channels/files.ts',
  'features/chat/channels/guard.ts',
  'features/chat/channels/members.ts',
  'features/chat/channels/notification-level.ts',
  'features/chat/channels/read-state.ts',
  'features/chat/channels/retention.ts',
  'features/chat/channels/settings.ts',
  'features/chat/channels/star.ts',
  'features/chat/channels/workspace-channels.ts',
  'features/chat/export.ts',
  'features/chat/incidents/incidents.ts',
  'features/chat/incidents/responders.ts',
  'features/chat/integrations/feeds.ts',
  'features/chat/integrations/github-app-webhook.ts',
  'features/chat/integrations/github-app.ts',
  'features/chat/integrations/github-issues.ts',
  'features/chat/integrations/github-work-events.ts',
  'features/chat/integrations/github-work.ts',
  'features/chat/integrations/github.ts',
  'features/chat/integrations/incoming-webhooks.ts',
  'features/chat/integrations/unfurl.ts',
  'features/chat/integrations/webhook.ts',
  'features/chat/notifications/missed-mail.ts',
  'features/chat/notifications/notifications.ts',
  'features/chat/personal-export.ts',
  'features/chat/reminders/delivery.ts',
  'features/chat/reminders/reminders.ts',
  'features/chat/saved/saved.ts',
  'features/chat/scheduled/delivery.ts',
  'features/chat/scheduled/scheduled.ts',
  'features/chat/search/saved-searches.ts',
  'features/chat/search/search.ts',
  'features/chat/sweeps.ts',
];

const chatFiles = (): string[] =>
  sourcesOf('chat')
    .map(shown)
    .filter((file) => file.startsWith('features/chat/'))
    .sort();

describe('what the scan of a file for the whole database’s names sees', () => {
  test('an import of each, with or without type, and under another name', () => {
    expect(
      wholeDatabaseImports("import { sql, type Executor, Transaction as Tx } from '@purlay/db';"),
    ).toEqual(['Executor', 'Transaction']);
    expect(wholeDatabaseImports("import type {\n  Database,\n  DB,\n} from '@purlay/db';")).toEqual(
      ['Database', 'DB'],
    );
  });

  test('and nothing in a comment, another package, or a name that is not the whole database', () => {
    expect(wholeDatabaseImports("// import { Executor } from '@purlay/db';")).toEqual([]);
    expect(wholeDatabaseImports("import { Executor } from './elsewhere';")).toEqual([]);
    expect(wholeDatabaseImports("import { sql, type Selectable } from '@purlay/db';")).toEqual([]);
  });
});

describe('chat behind its handle', () => {
  const stillOnTheWholeDatabase = chatFiles().filter(
    (file) =>
      wholeDatabaseImports(readFileSync(join(import.meta.dir, file), 'utf8')).length > 0 &&
      !file.endsWith('/schema.ts'),
  );

  test('the files that still take the whole database are the list, no more and no fewer', () => {
    expect(chatFiles().length).toBeGreaterThan(50);
    expect(stillOnTheWholeDatabase).toEqual([...NOT_YET_BEHIND_THE_HANDLE].sort());
  });
});
