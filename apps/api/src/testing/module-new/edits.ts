/**
 * The lines a new module adds to files that exist (`docs/MODULE-GUIDE.md`): each at an anchor the file keeps, so a
 * changed file stops the generator and does not let it guess. What can be derived is not here: `MODULES.md` §9 lists it.
 */
import { fill, type Edit, type Names, type Options } from './plan';

const ISSUES_MODULE_IMPORT = "import { issuesModule } from './features/issues/module';\n";
const BUNDLE_END = '] as const satisfies readonly BundledModule[];';
const ISSUES_ID = "Type.Literal('issues')";
const ISSUES_EXPORT = "export * from './issues';\n";
const ISSUES_SET = "  { id: 'issues', directory: join(MIGRATIONS_DIRECTORY, 'issues') },\n";
const ISSUES_REQUIRES = '  issues: [],\n';
const ISSUES_OWNER = "  issues: 'issues',\n";
const ISSUES_LIFECYCLE = "  issues: decided('anonymised', 'until-removed'),\n";
const ISSUES_ENDPOINT_IMPORT =
  "import { CreateIssueRequest, Issue, IssuePage, IssueQuery, UpdateIssueRequest } from './issues';\n";
const ISSUES_HOT_PATH =
  "  issues: { judged: 'baseline', prepare: timeIssuesList, makeBusy: issuesBusy },\n";
const WITHOUT_A_HOT_PATH = '  // module:new:without-a-hot-path\n';
const NO_HOT_PATH_YET =
  'a scaffolded list has no measured path yet; give it one of the baseline shape before it carries traffic';
const ENDPOINTS_END = '] as const satisfies readonly EndpointSpec[];';

const EDITS: readonly Edit[] = [
  {
    file: 'apps/api/src/composition.ts',
    anchor: ISSUES_MODULE_IMPORT,
    text: `${ISSUES_MODULE_IMPORT}import { __CAMEL__Module } from './features/__ID__/module';\n`,
  },
  {
    file: 'apps/api/src/composition.ts',
    anchor: BUNDLE_END,
    text: `  __CAMEL__Module,\n${BUNDLE_END}`,
  },
  {
    file: 'packages/types/src/modules.ts',
    anchor: ISSUES_ID,
    text: "Type.Literal('issues'), Type.Literal('__ID__')",
  },
  {
    file: 'packages/types/src/index.ts',
    anchor: ISSUES_EXPORT,
    text: `${ISSUES_EXPORT}export * from './__ID__';\n`,
  },
  {
    file: 'packages/types/src/endpoints.ts',
    anchor: ISSUES_ENDPOINT_IMPORT,
    text: `${ISSUES_ENDPOINT_IMPORT}import { Create__PASCAL__ItemRequest, __PASCAL__ItemList, __PASCAL__Item } from './__ID__';\n`,
  },
  {
    file: 'packages/types/src/endpoints.ts',
    anchor: ENDPOINTS_END,
    text: `  read({
    id: 'list__PASCAL__',
    method: 'GET',
    path: '/api/workspaces/:workspaceId/__ID__',
    auth: 'session',
    responses: { 200: __PASCAL__ItemList },
  }),
  read({
    id: 'create__PASCAL__Item',
    method: 'POST',
    path: '/api/workspaces/:workspaceId/__ID__',
    auth: 'session',
    body: Create__PASCAL__ItemRequest,
    responses: { 201: __PASCAL__Item },
  }),
${ENDPOINTS_END}`,
  },
  {
    file: 'packages/db/src/migrator.ts',
    anchor: ISSUES_SET,
    text: `${ISSUES_SET}  { id: '__ID__', directory: join(MIGRATIONS_DIRECTORY, '__ID__') },\n`,
  },
  {
    file: 'packages/db/src/migrator.ts',
    anchor: ISSUES_REQUIRES,
    text: `${ISSUES_REQUIRES}  '__ID__': [__REQUIRES__],\n`,
  },
  {
    file: 'packages/db/src/table-owners.ts',
    anchor: ISSUES_OWNER,
    text: `${ISSUES_OWNER}\n  // __PASCAL__ (its own set, \`migrations/__ID__/\`).\n  __SNAKE__: '__ID__',\n`,
  },
  {
    file: 'packages/db/src/table-lifecycle.ts',
    anchor: ISSUES_LIFECYCLE,
    text: `${ISSUES_LIFECYCLE}\n  // __PASCAL__: rows that name nobody (its own set, \`migrations/__ID__/\`).\n  __SNAKE__: decided({ nobody: 'a row is a title and names no person' }, 'until-removed'),\n`,
  },
  {
    file: 'apps/api/src/cli/budget-latency.ts',
    anchor: ISSUES_HOT_PATH,
    text: `${ISSUES_HOT_PATH}  '__ID__': { none: '${NO_HOT_PATH_YET}' },\n`,
  },
  {
    file: 'apps/api/src/cli/budget-latency.test.ts',
    anchor: WITHOUT_A_HOT_PATH,
    text: `  '__ID__': '${NO_HOT_PATH_YET}',\n${WITHOUT_A_HOT_PATH}`,
  },
];

/** The edits of a module called `names`, in the order they are made. */
export const editsFor = (names: Names, options: Options): Edit[] =>
  EDITS.map((edit) => ({ ...edit, text: fill(edit.text, names, options) }));
