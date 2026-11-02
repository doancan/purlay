/**
 * Each entry of a trail as one line of the log (D-222): ids and fixed words, never a name — and every
 * process that can write the trail hands its logger over, so no deployment's lines quietly go nowhere.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NO_LOG } from '../../platform/events';
import { aRecordingLogger } from '../../testing/doubles';
import { sendAuditLinesTo, writeAuditLine } from './lines';

const SOURCE = join(import.meta.dir, '..', '..');

afterEach(() => {
  sendAuditLinesTo(NO_LOG);
});

const AT = new Date('2026-10-31T09:15:00.000Z');
const ENTRY = '0199155c-6200-7b7f-8c11-2a4d3f9e1b70';
const ACTOR = '0199155c-6200-7b7f-8c11-000000000001';
const WORKSPACE = '0199155c-6200-7b7f-8c11-000000000002';
const CHANNEL = '0199155c-6200-7b7f-8c11-000000000003';

describe('an audit line', () => {
  test('says the action, who, to what, where and when — by id — and nothing of the metadata but ids', () => {
    const { log, lines } = aRecordingLogger();
    sendAuditLinesTo(log);
    writeAuditLine({
      trail: 'workspace',
      entryId: ENTRY,
      action: 'channel.renamed',
      actorId: ACTOR,
      workspaceId: WORKSPACE,
      targetType: 'channel',
      targetId: CHANNEL,
      at: AT,
      // Names a person can read, beside an id: only the id is a line's.
      metadata: { from: 'genel', to: 'Gizli Proje — Şükrü', channelId: CHANNEL, messages: '12' },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'audit entry recorded',
      audit: {
        trail: 'workspace',
        entryId: ENTRY,
        action: 'channel.renamed',
        actorId: ACTOR,
        workspaceId: WORKSPACE,
        targetType: 'channel',
        targetId: CHANNEL,
        relatedIds: { channelId: CHANNEL },
        at: '2026-10-31T09:15:00.000Z',
      },
    });
    const written = JSON.stringify(lines[0]);
    expect(written).not.toContain('Şükrü');
    expect(written).not.toContain('genel');
    expect(written).not.toContain('"messages"');
  });

  test('of the server’s own trail names no workspace and no target', () => {
    const { log, lines } = aRecordingLogger();
    sendAuditLinesTo(log);
    writeAuditLine({
      trail: 'server',
      entryId: ENTRY,
      action: 'server.sign_up_changed',
      actorId: ACTOR,
      workspaceId: null,
      targetType: null,
      targetId: null,
      at: AT,
    });
    expect(lines[0]).toMatchObject({
      audit: { trail: 'server', workspaceId: null, targetId: null, relatedIds: {} },
    });
  });

  test('goes nowhere until a process says where, and nothing throws', () => {
    const { lines } = aRecordingLogger();
    expect(() => {
      writeAuditLine({
        trail: 'server',
        entryId: ENTRY,
        action: 'server.sign_up_changed',
        actorId: ACTOR,
        workspaceId: null,
        targetType: null,
        targetId: null,
        at: AT,
      });
    }).not.toThrow();
    expect(lines).toEqual([]);
  });
});

/**
 * The processes that open the database and so can write a trail, each with the reason it hands its
 * logger over or does not. A new one fails here until it is decided.
 */
const NOT_LOGGED: Readonly<Record<string, string>> = {
  'cli/admin-reset-password.ts':
    'its output is a contract of one line (D-179 §4); the change is on the server’s trail all the same',
  'cli/demo-session.ts': 'the demo’s sign-in: a person and a session, nothing on a trail',
  'cli/seed-demo.ts': 'the demo’s seed, through the API with a silent log by design',
};

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.includes('.test.'),
    )
    .map((entry) => join(entry.parentPath, entry.name));

describe('every process that writes a trail logs it', () => {
  const opening = sources(SOURCE)
    .filter((path) => !path.includes(join(SOURCE, 'testing')))
    .filter((path) => readFileSync(path, 'utf8').includes('createDatabase('))
    .map((path) => relative(SOURCE, path));

  test('the sweep finds the API itself, so it is not looking at nothing', () => {
    expect(opening).toContain('index.ts');
    expect(opening).toContain('cli/jobs.ts');
  });

  test('hands its logger over, or says why not', () => {
    const silent = opening.filter(
      (path) =>
        !readFileSync(join(SOURCE, path), 'utf8').includes('sendAuditLinesTo(') &&
        NOT_LOGGED[path] === undefined,
    );
    expect(silent).toEqual([]);
  });

  test('names no process that is not one', () => {
    expect(Object.keys(NOT_LOGGED).filter((path) => !opening.includes(path))).toEqual([]);
  });
});
