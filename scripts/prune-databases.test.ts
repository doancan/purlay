/**
 * Which databases on the test server are scratch: the ones a run made and a killed run left. A guess that
 * is wrong drops somebody's data, so the list is an allow-list of the shapes this project's own tools make,
 * and the one they are told is the developer's is never in it, whatever it is called.
 */
import { describe, expect, test } from 'bun:test';
import { prune, scratchDatabases, type DatabaseServer } from './database-pruning';

describe('the databases a prune may drop', () => {
  const made = [
    'purlay_0123456789ab',
    'purlay_template',
    'purlay_demo',
    'purlay_demo_actions',
    'purlay_e2e_4173',
    'purlay_e2e_fresh_4223',
    'purlay_browse_verify',
    'purlay_browse_verify_template',
    'purlay_preload_probe_0a1b2c3d4e_template',
    'purlay_harness_stale_0a1b2c3d4e',
  ];

  test('are the shapes the tools make: clones, the template, the demo and the browser suite, a verify run', () => {
    expect(scratchDatabases([...made, 'postgres'], 'purlay')).toEqual(made);
  });

  test('never the configured database, the developer’s own, or anything else on the server', () => {
    const kept = ['postgres', 'template1', 'purlay', 'purlay_live', 'appmanager', 'purlay_staging'];
    expect(scratchDatabases(kept, 'purlay')).toEqual([]);
    // Even a name that has the shape of a scratch one, when it is the configured database.
    expect(scratchDatabases(['purlay_demo'], 'purlay_demo')).toEqual([]);
  });

  test('a clone is a twelve-digit hexadecimal suffix, not any suffix', () => {
    expect(
      scratchDatabases(['purlay_notes', 'purlay_0123456789a', 'purlay_0123456789abc'], 'purlay'),
    ).toEqual([]);
  });
});

describe('a prune', () => {
  const aServer = (
    names: string[],
    busy: string[] = [],
  ): { server: DatabaseServer; dropped: string[][] } => {
    const dropped: string[][] = [];
    return {
      dropped,
      server: {
        databases: () => Promise.resolve(names),
        inUse: () => Promise.resolve(busy),
        drop: (doomed): Promise<void> => {
          dropped.push([...doomed]);
          return Promise.resolve();
        },
      },
    };
  };
  const NAMES = ['postgres', 'purlay', 'purlay_live', 'purlay_demo_a', 'purlay_0123456789ab'];

  test('is dry unless told to drop: it lists, and drops nothing', async () => {
    const { server, dropped } = aServer(NAMES);
    const said: string[] = [];
    await prune(server, 'purlay', false, (line) => said.push(line));
    expect(dropped).toEqual([]);
    expect(said.join('\n')).toContain('purlay_demo_a');
    expect(said.join('\n')).not.toContain('purlay_live');
    expect(said.join('\n')).toContain('2 scratch databases');
  });

  test('drops exactly the scratch ones, together, when told to', async () => {
    const { server, dropped } = aServer(NAMES);
    const said: string[] = [];
    await prune(server, 'purlay', true, (line) => said.push(line));
    expect(dropped).toEqual([['purlay_demo_a', 'purlay_0123456789ab']]);
    expect(said).toEqual(['dropped 2 scratch databases']);
  });

  test('says so when there is nothing, and drops nothing', async () => {
    const { server, dropped } = aServer(['postgres', 'purlay', 'purlay_live']);
    const said: string[] = [];
    await prune(server, 'purlay', true, (line) => said.push(line));
    expect({ dropped, said }).toEqual({ dropped: [], said: ['no scratch databases'] });
  });

  test('leaves alone one that somebody is connected to: a run of another session is not a leftover', async () => {
    const { server, dropped } = aServer(NAMES, ['purlay_demo_a']);
    const said: string[] = [];
    await prune(server, 'purlay', true, (line) => said.push(line));
    expect(dropped).toEqual([['purlay_0123456789ab']]);
    expect(said.join('\n')).toContain('dropped 1 scratch databases');
    expect(said.join('\n')).toContain('1 in use, left alone');
  });
});
