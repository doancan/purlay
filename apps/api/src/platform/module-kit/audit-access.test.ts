/**
 * Who reads which audit rows (`audit-access.ts`): the core's by `audit.read`, a module's by the permission it names, and a
 * module that is not run holds no permission of its own.
 */
import { describe, expect, test } from 'bun:test';
import { auditAccess } from './audit-access';
import { CORE_PERMISSIONS, permissionTable } from './permissions';

const INTERNAL = { name: 'notes.read-internal', minimumRole: 'owner' } as const;
const groups = [
  { read: 'audit.read', actions: ['note.created'] },
  { read: INTERNAL.name, actions: ['note.pinned'] },
];

describe('the audit rows a role reads', () => {
  const running = auditAccess(permissionTable([...CORE_PERMISSIONS, INTERNAL]), groups);

  test('an owner and an admin open the trail and a member does not', () => {
    expect(running.mayRead('member')).toBe(false);
    expect(running.mayRead('admin')).toBe(true);
    expect(running.mayRead('owner')).toBe(true);
  });

  test('a role is not shown the actions whose permission it lacks', () => {
    expect(running.unreadable('admin')).toEqual(['note.pinned']);
    expect(running.unreadable('owner')).toEqual([]);
  });

  test('a module that is not run has no permission, so what only it could read is hidden from everybody', () => {
    const notRun = auditAccess(permissionTable([...CORE_PERMISSIONS]), groups);
    expect(notRun.unreadable('owner')).toEqual(['note.pinned']);
    expect(notRun.unreadable('admin')).toEqual(['note.pinned']);
  });

  test('what the core records is read by whoever reads the trail, whichever modules run', () => {
    expect(auditAccess(permissionTable([...CORE_PERMISSIONS]), []).unreadable('admin')).toEqual([]);
  });
});
