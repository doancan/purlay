/**
 * The settings' pages, and who sees each (D-146): the one list the navigation, the screen's switch
 * and the palette read, so a page added here is a page everywhere and a page left out is nowhere.
 *
 * What a person sees is what the server would let them do. The workspace's pages are an owner's or
 * an admin's (D-111); how long history is kept and exports are an owner's alone (D-139 §4, D-140).
 * A page somebody may not open is not drawn, and its address is *not found*.
 */
import type { UserRole } from '@purlay/types';
import type { GlyphName } from '../../components/icon';

const SETTINGS_SECTIONS = [
  { id: 'profile', group: 'account', glyph: 'person', for: 'everyone' },
  { id: 'preferences', group: 'account', glyph: 'preferences', for: 'everyone' },
  { id: 'notifications', group: 'account', glyph: 'notifications', for: 'everyone' },
  { id: 'shortcuts', group: 'account', glyph: 'shortcuts', for: 'everyone' },
  { id: 'account', group: 'account', glyph: 'lock', for: 'everyone' },
  { id: 'general', group: 'workspace', glyph: 'settings', for: 'admins' },
  { id: 'members', group: 'workspace', glyph: 'people', for: 'admins' },
  { id: 'invitations', group: 'workspace', glyph: 'invite', for: 'admins' },
  { id: 'integrations', group: 'workspace', glyph: 'integration', for: 'admins' },
  { id: 'audit', group: 'workspace', glyph: 'audit', for: 'admins' },
  { id: 'data', group: 'workspace', glyph: 'history', for: 'owners' },
  { id: 'server', group: 'server', glyph: 'integration', for: 'serverAdmin' },
] as const satisfies readonly {
  readonly id: string;
  readonly group: 'account' | 'workspace' | 'server';
  readonly glyph: GlyphName;
  readonly for: 'everyone' | 'admins' | 'owners' | 'serverAdmin';
}[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type SettingsSectionId = SettingsSection['id'];

/** The page `/w/:slug/settings` opens. */
export const FIRST_SECTION: SettingsSectionId = 'profile';

/**
 * Whether this person is offered a page. The server's own page is the server administrator's alone
 * (`GET /api/me`'s `isServerAdmin`, D-179 §4.8) — never a workspace role's: an owner of a workspace is
 * not the server's administrator. The server refuses the page's calls to anybody else regardless.
 */
const allowed = (
  section: SettingsSection,
  role: UserRole | undefined,
  serverAdmin: boolean,
): boolean =>
  section.for === 'everyone' ||
  (section.for === 'admins' && (role === 'owner' || role === 'admin')) ||
  (section.for === 'owners' && role === 'owner') ||
  (section.for === 'serverAdmin' && serverAdmin);

/** The pages this person may open, in the navigation's order. */
export const sectionsFor = (
  role: UserRole | undefined,
  serverAdmin = false,
): readonly SettingsSection[] =>
  SETTINGS_SECTIONS.filter((section) => allowed(section, role, serverAdmin));

/** The page an address names, if this person may open it; otherwise null, which is *not found*. */
export const sectionFor = (
  id: string,
  role: UserRole | undefined,
  serverAdmin = false,
): SettingsSection | null =>
  sectionsFor(role, serverAdmin).find((section) => section.id === id) ?? null;
