/**
 * What the issues module tells the shell (D-250, D-254): one route, one place on the rail and in the palette. Data
 * only — the screen is `issues-screen.tsx`, behind `load`, and nothing else imports it.
 */
import { ISSUES_AUDIT_ACTIONS } from '@purlay/types';
import { defineModule, type ModuleScreens } from '../../modules/manifest';

const routes = { issues: '/w/:slug/issues' } as const;

/** The screens `issues-screen.tsx` must export: one for each route above. */
export type IssuesScreens = ModuleScreens<typeof routes>;

export const issues = defineModule({
  id: 'issues',
  load: () => import('./issues-screen'),
  waiting: 'plain',
  routes,
  rail: [{ route: 'issues', glyph: 'issues', label: 'issues.title' }],
  palette: [{ route: 'issues', glyph: 'issues', label: 'issues.title' }],
  shortcuts: [],
  settings: [],
  auditActions: ISSUES_AUDIT_ACTIONS,
  notices: { issue_assigned: { words: 'issues.notice.assigned', path: 'issues' } },
});
