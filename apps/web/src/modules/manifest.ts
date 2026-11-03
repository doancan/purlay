/**
 * What a module tells the shell about itself (D-250, `docs/MODULES.md` §6): data and one loader, nothing the
 * shell would have to draw with. A manifest holds route paths, the entries the rail and the palette list, the
 * shortcut rows and the settings pages the module owns; its screens stay behind `load`, an `import()` of the
 * module's own chunk, so the shell that reads every manifest carries none of a screen.
 *
 * **A manifest imports no component, only types.** The router reads the manifests to build its route table, so a
 * manifest that imported a component which imports the router would be a cycle that fails at start-up.
 */
import type { GlyphName } from '../components/icon';
import type { KeyLabels } from '../features/shortcuts/platform';
import type { PlainKey } from '../i18n/types';

/** A route of a module is inside a workspace, so the shell around it is `Shell` and its params carry the slug. */
type ModuleRoutePath = `/w/:slug/${string}`;

/** The names of a pattern's params: `/w/:slug/c/:channelId` has `slug` and `channelId`. */
export type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<Rest>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

/** What a module's chunk exports for its routes: one screen each, given the params its pattern names. */
export type ModuleScreens<Routes extends Readonly<Record<string, string>>> = {
  readonly [Name in keyof Routes]: (props: {
    readonly params: Readonly<Record<ParamNames<Routes[Name]>, string>>;
  }) => React.ReactNode;
};

/** A place the rail or the palette lists: a route of the module (or of the core), a glyph and a name. */
interface ModuleLink {
  readonly route: string;
  readonly glyph: GlyphName;
  readonly label: PlainKey;
}

/** One row of the shortcuts reference, in the group it names, after the row it names (or last). */
export interface ModuleShortcut {
  readonly group: PlainKey;
  readonly label: PlainKey;
  readonly after?: PlainKey;
  /** Alternatives; each is the keys pressed together, in order. */
  readonly keys: (k: KeyLabels) => readonly (readonly string[])[];
}

export type SettingsGroup = 'account' | 'workspace' | 'server';
export type SettingsAudience = 'everyone' | 'admins' | 'owners' | 'serverAdmin';

/** A settings page the module owns, after the page it names (or last); its screen is in the settings' chunk. */
export interface ModuleSettingsPage {
  readonly id: string;
  readonly group: SettingsGroup;
  readonly glyph: GlyphName;
  readonly for: SettingsAudience;
  readonly after?: string;
}

/** What a module's chunk exports: `screens`, one per route, by the route's name. */
export interface ModuleChunk {
  readonly screens: Readonly<Record<string, (props: never) => React.ReactNode>>;
}

export interface ModuleManifest {
  /** The id the server lists in `MODULES` (D-250). */
  readonly id: string;
  /** The module's own chunk, by `import()`. */
  readonly load: () => Promise<ModuleChunk>;
  /** Ask for the chunk in the first commit of one of its routes, beside the request for the session. */
  readonly preload?: true;
  /** What stands in for a screen while its chunk loads: the shell's bar with a skeleton, or the skeleton alone. */
  readonly waiting: 'bar' | 'plain';
  readonly routes: Readonly<Record<string, ModuleRoutePath>>;
  readonly rail: readonly ModuleLink[];
  /** The places the palette lists; its id is `view:<route>`. */
  readonly palette: readonly ModuleLink[];
  readonly shortcuts: readonly ModuleShortcut[];
  readonly settings: readonly ModuleSettingsPage[];
}

/** A shortcut row, its group and label by key, and the row it sits after; the keys are a function of the platform's names. */
export const shortcut = (
  group: PlainKey,
  label: PlainKey,
  keys: ModuleShortcut['keys'],
  after?: PlainKey,
): ModuleShortcut => ({ group, label, keys, ...(after === undefined ? {} : { after }) });

/** Says what a manifest must be and keeps what it is: the literal routes and ids, which the types are made of. */
export const defineModule = <const M extends ModuleManifest>(manifest: M): M => manifest;
