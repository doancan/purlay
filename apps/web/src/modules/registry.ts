/**
 * The modules this client knows (D-250, `docs/MODULES.md` §6): the one list the router, the outlet, the rail, the
 * palette, the shortcuts and the settings read. A module is here when its manifest is; the server's own list of
 * what it runs (`MODULES` in the session) then decides which of them are drawn.
 */
import { chat } from '../features/chat/manifest';
import { issues } from '../features/issues/manifest';

export const MODULES = [chat, issues] as const;

export type ModuleManifestOf = (typeof MODULES)[number];
export type ModuleId = ModuleManifestOf['id'];

type Intersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
  value: infer Both,
) => void
  ? Both
  : never;

/** Every module's routes in one record: the names and the patterns the router's table is made of. */
export type ModuleRoutes = Intersection<ModuleManifestOf['routes']>;

/** The manifests of the modules a server runs, in the registry's order. */
export const running = (modules: readonly string[]): readonly ModuleManifestOf[] =>
  MODULES.filter((module) => modules.includes(module.id));

/** A place a manifest puts on the rail, its route as the literal the manifest spells, so the rail's links are checked against the route table. */
export type RailEntry = ModuleManifestOf['rail'][number];
