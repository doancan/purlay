/**
 * What a role holds (`permissions.ts`): the lowest role named and those above it, and nothing that nobody declared.
 */
import { describe, expect, test } from 'bun:test';
import { USER_ROLES } from '../../testing/roles';
import { permissionTable } from './permissions';

describe('the permission table', () => {
  const table = permissionTable([
    { name: 'issues.delete-any', minimumRole: 'admin' },
    { name: 'notes.publish', minimumRole: 'owner' },
    { name: 'notes.read', minimumRole: 'member' },
  ]);

  test('a role holds what its own rank reaches and nothing above', () => {
    const held = (name: string): string[] => USER_ROLES.filter((role) => table.holds(role, name));
    expect(held('notes.read')).toEqual(['member', 'admin', 'owner']);
    expect(held('issues.delete-any')).toEqual(['admin', 'owner']);
    expect(held('notes.publish')).toEqual(['owner']);
  });

  test('a permission nobody declared is held by nobody, the owner included', () => {
    expect(USER_ROLES.filter((role) => table.holds(role, 'notes.delete'))).toEqual([]);
    expect(permissionTable([]).holds('owner', 'notes.read')).toBe(false);
  });
});
