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
import type { SettingsAudience, SettingsGroup } from '../../modules/manifest';
import { MODULES, type ModuleId, type ModuleManifestOf } from '../../modules/registry';

const CORE_SECTIONS = [
  { id: 'profile', group: 'account', glyph: 'person', for: 'everyone' },
  { id: 'preferences', group: 'account', glyph: 'preferences', for: 'everyone' },
  { id: 'shortcuts', group: 'account', glyph: 'shortcuts', for: 'everyone' },
  { id: 'account', group: 'account', glyph: 'lock', for: 'everyone' },
  { id: 'about', group: 'account', glyph: 'info', for: 'everyone' },
  { id: 'general', group: 'workspace', glyph: 'settings', for: 'admins' },
  { id: 'company', group: 'workspace', glyph: 'lock', for: 'admins' },
  { id: 'members', group: 'workspace', glyph: 'people', for: 'admins' },
  { id: 'invitations', group: 'workspace', glyph: 'invite', for: 'admins' },
  { id: 'audit', group: 'workspace', glyph: 'audit', for: 'admins' },
  { id: 'data', group: 'workspace', glyph: 'history', for: 'owners' },
  { id: 'server', group: 'server', glyph: 'integration', for: 'serverAdmin' },
] as const satisfies readonly {
  readonly id: string;
  readonly group: SettingsGroup;
  readonly glyph: GlyphName;
  readonly for: SettingsAudience;
}[];

type ModulePage = ModuleManifestOf['settings'][number];

export type CoreSettingsSectionId = (typeof CORE_SECTIONS)[number]['id'];
export type SettingsSection =
  | ((typeof CORE_SECTIONS)[number] & { readonly module?: never; readonly load?: never })
  | (ModulePage & { readonly module: ModuleId });

export type SettingsSectionId = SettingsSection['id'];

/**
 * Every page, in the navigation's order: the core's, with each module's pages after the page its manifest names
 * (or last), so a module's page sits where it belongs and not at the end.
 */
const SETTINGS_SECTIONS: readonly SettingsSection[] = MODULES.reduce<readonly SettingsSection[]>(
  (sections, module) =>
    module.settings.reduce<readonly SettingsSection[]>((all, page) => {
      const after = all.findIndex((section) => section.id === page.after);
      const at = after === -1 ? all.length : after + 1;
      return [...all.slice(0, at), { ...page, module: module.id }, ...all.slice(at)];
    }, sections),
  CORE_SECTIONS,
);

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
  modules: readonly string[],
): boolean =>
  (section.module === undefined || modules.includes(section.module)) &&
  (section.for === 'everyone' ||
    (section.for === 'admins' && (role === 'owner' || role === 'admin')) ||
    (section.for === 'owners' && role === 'owner') ||
    (section.for === 'serverAdmin' && serverAdmin));

/** The pages this person may open, in the navigation's order. */
export const sectionsFor = (
  role: UserRole | undefined,
  serverAdmin: boolean,
  modules: readonly string[],
): readonly SettingsSection[] =>
  SETTINGS_SECTIONS.filter((section) => allowed(section, role, serverAdmin, modules));

/** The page an address names, if this person may open it; otherwise null, which is *not found*. */
export const sectionFor = (
  id: string,
  role: UserRole | undefined,
  serverAdmin: boolean,
  modules: readonly string[],
): SettingsSection | null =>
  sectionsFor(role, serverAdmin, modules).find((section) => section.id === id) ?? null;
