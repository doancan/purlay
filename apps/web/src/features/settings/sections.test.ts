import { describe, expect, test } from 'bun:test';
import { sectionFor, sectionsFor } from './sections';

const ids = (modules: readonly string[]): string[] =>
  sectionsFor('owner', false, modules).map((section) => section.id);

describe('the settings pages of the modules a server runs', () => {
  test('chat’s pages — notifications, integrations — are offered with chat and not without', () => {
    expect(ids(['chat'])).toContain('notifications');
    expect(ids(['chat'])).toContain('integrations');
    for (const gone of ['notifications', 'integrations']) {
      expect(ids([])).not.toContain(gone);
      expect(sectionFor(gone, 'owner', false, [])).toBeNull();
    }
  });

  test('the core’s pages are offered either way', () => {
    for (const kept of [
      'profile',
      'preferences',
      'account',
      'general',
      'members',
      'invitations',
      'data',
    ]) {
      expect(ids([])).toContain(kept);
    }
  });
});

test('the channel navigation hint opens only General, with chat, and never other workspace administration', () => {
  expect(
    sectionFor('general', 'member', false, ['chat'], [], ['channel.settings.manage'])?.id,
  ).toBe('general');
  expect(sectionFor('general', 'member', false, [], [], ['channel.settings.manage'])).toBeNull();
  expect(
    sectionFor('general', 'member', false, ['chat'], [], ['channel.members.manage']),
  ).toBeNull();
  expect(sectionFor('general', 'member', false, ['chat'])).toBeNull();
  for (const id of [
    'company',
    'security',
    'directory',
    'access-people',
    'access-roles',
    'access-groups',
    'data',
  ])
    expect(sectionFor(id, 'member', false, ['chat'], [], ['channel.settings.manage'])).toBeNull();
});

describe('the settings menu’s marks', () => {
  test('no two pages of one group share a mark, so a long menu can be told apart at a glance', () => {
    const pages = sectionsFor('owner', true, ['chat', 'issues']);
    for (const group of new Set(pages.map((page) => page.group))) {
      const marks = pages.filter((page) => page.group === group).map((page) => page.glyph);
      expect(new Set(marks).size).toBe(marks.length);
    }
  });
});
