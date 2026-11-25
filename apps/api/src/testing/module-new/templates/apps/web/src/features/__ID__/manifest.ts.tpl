/**
 * What __ID__ tells the shell (D-250, `docs/MODULES.md` §6): one route and one place on the rail and in the palette. Data
 * only — the screen is `__ID__-screen.tsx`, behind `load`, and nothing else imports it.
 */
import { defineModule, type ModuleScreens } from '../../modules/manifest';

const routes = { __CAMEL__: '/w/:slug/__ID__' } as const;

/** The screens `__ID__-screen.tsx` must export: one for each route above. */
export type __PASCAL__Screens = ModuleScreens<typeof routes>;

export const __CAMEL__ = defineModule({
  id: '__ID__',
  load: () => import('./__ID__-screen'),
  waiting: 'plain',
  routes,
  rail: [{ route: '__CAMEL__', glyph: 'bullet-list', label: '__ID__.title' }],
  palette: [{ route: '__CAMEL__', glyph: 'bullet-list', label: '__ID__.title' }],
  shortcuts: [],
  settings: [],
  auditActions: [],
  notices: {},
});
