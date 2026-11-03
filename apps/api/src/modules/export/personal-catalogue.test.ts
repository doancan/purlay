import { describe, expect, test } from 'bun:test';
import { sql, type RawBuilder } from '@purlay/db';
import {
  assemblePersonalCatalogue,
  personalTableExport,
  type CorePersonalContribution,
  type PersonalContribution,
  type PersonalTableExport,
} from './personal-catalogue';

const bounds = (): ReturnType<PersonalTableExport['bounds']> => ({
  where: sql`true`,
  order: 'id',
});

/** A table with no column decided, which a test about order and sums does not need. */
const table = (name: 'workspaces' | 'users' | 'channels' | 'messages'): PersonalTableExport =>
  personalTableExport(name, {} as never, bounds);

const core: CorePersonalContribution = {
  id: 'core',
  head: [table('users'), table('workspaces')],
  tail: [],
  tables: [],
  workspaces: () => [sql`select 1`],
};

const chat: PersonalContribution = {
  id: 'chat',
  tables: [table('channels'), table('messages')],
  workspaces: () => [sql`select 2`, sql`select 3`],
  files: () => sql`message_id is not null`,
};

/** Workspaces that say they were asked for, so a test can see who is asked and in what order. */
const asking =
  (log: string[], id: string): (() => readonly RawBuilder<unknown>[]) =>
  () => {
    log.push(id);
    return [sql`select 1`];
  };

describe('the personal export catalogue', () => {
  test('writes the core’s first tables, then each module’s, then the core’s last', () => {
    const withTail: CorePersonalContribution = { ...core, tail: [table('messages')] };
    const moduleTable: PersonalContribution = { ...chat, tables: [table('channels')] };
    expect(assemblePersonalCatalogue(withTail, [moduleTable]).order).toEqual([
      'users',
      'workspaces',
      'channels',
      'messages',
    ]);
  });

  test('is the core’s alone when no module is carried', () => {
    const alone = assemblePersonalCatalogue(core, []);
    expect(alone.order).toEqual(['users', 'workspaces']);
    expect(alone.files('u')).toBeUndefined();
  });

  test('refuses a table named twice, and names it', () => {
    const again: PersonalContribution = { ...chat, tables: [table('users')] };
    expect(() => assemblePersonalCatalogue(core, [again])).toThrow('names a table twice: users');
  });

  test('has no table it was not given', () => {
    expect(() => assemblePersonalCatalogue(core, []).table('messages')).toThrow(
      'has no table messages',
    );
  });

  test('asks every contribution for the workspaces it names, the core first, and takes a module’s files', () => {
    const asked: string[] = [];
    const spying = assemblePersonalCatalogue({ ...core, workspaces: asking(asked, 'core') }, [
      { ...chat, workspaces: asking(asked, 'chat') },
    ]);
    spying.workspaces('u');
    expect(asked).toEqual(['core', 'chat']);
    expect(assemblePersonalCatalogue(core, [chat]).files('u')).toBeDefined();
  });
});
