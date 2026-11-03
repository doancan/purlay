import { describe, expect, test } from 'bun:test';
import { sql, type RawBuilder } from '@purlay/db';
import {
  assembleCatalogue,
  tableExport,
  type Bounds,
  type CoreExportContribution,
  type ExportContribution,
  type Scope,
  type TableExport,
} from './catalogue';

const bounds = (): Bounds => ({ where: sql`true`, order: 'id' });

/** A table with no column decided, which a test about order and sums does not need. */
const table = (name: 'workspaces' | 'users' | 'channels' | 'messages' | 'audit_log'): TableExport =>
  tableExport(name, {} as never, bounds);

const core: CoreExportContribution = {
  id: 'core',
  head: [table('workspaces'), table('users')],
  tail: [table('audit_log')],
  tables: [],
  people: () => [sql`select 1`],
  audit: () => ({ from: 'core' }),
};

const chat: ExportContribution = {
  id: 'chat',
  tables: [table('channels'), table('messages')],
  people: () => [sql`select 2`, sql`select 3`],
  prepare: (_executor, request) => Promise.resolve(`channels of ${request.workspaceId}`),
  files: () => sql`message_id is not null`,
  audit: (rows) => ({ messages: String(rows['messages'] ?? 0) }),
};

/** People that say they were asked for, so a test can see who is asked and in what order. */
const asking =
  (log: string[], id: string): (() => readonly RawBuilder<unknown>[]) =>
  () => {
    log.push(id);
    return [sql`select 1`];
  };

const scope: Scope = { workspaceId: 'w', kind: 'all', prepared: {} };

describe('the export catalogue', () => {
  test('writes the core’s first tables, then each module’s, then the core’s last', () => {
    expect(assembleCatalogue(core, [chat]).order).toEqual([
      'workspaces',
      'users',
      'channels',
      'messages',
      'audit_log',
    ]);
  });

  test('is the core’s alone when no module is carried', () => {
    const alone = assembleCatalogue(core, []);
    expect(alone.order).toEqual(['workspaces', 'users', 'audit_log']);
    expect(alone.files(scope)).toBeUndefined();
    expect(alone.audit({ messages: 4 })).toEqual({ from: 'core' });
  });

  test('refuses a table named twice, and names it', () => {
    const again: ExportContribution = { ...chat, tables: [table('users')] };
    expect(() => assembleCatalogue(core, [again])).toThrow('names a table twice: users');
  });

  test('has no table it was not given', () => {
    expect(() => assembleCatalogue(core, []).table('messages')).toThrow('has no table messages');
  });

  test('asks every contribution for the people it names, the core first, and takes a module’s files and line for the trail', () => {
    const catalogue = assembleCatalogue(core, [chat]);
    const asked: string[] = [];
    const spying = assembleCatalogue({ ...core, people: asking(asked, 'core') }, [
      { ...chat, people: asking(asked, 'chat') },
    ]);
    spying.people(scope);
    expect(asked).toEqual(['core', 'chat']);
    expect(catalogue.files(scope)).toBeDefined();
    expect(catalogue.audit({ messages: 7 })).toEqual({ from: 'core', messages: '7' });
  });

  test('asks each contribution what it covers, by its id', async () => {
    const catalogue = assembleCatalogue(core, [chat]);
    const covered = await catalogue.scopeOf({} as never, { kind: 'all', workspaceId: 'w1' });
    expect(covered).toEqual({
      workspaceId: 'w1',
      kind: 'all',
      prepared: { chat: 'channels of w1' },
    });
  });
});
