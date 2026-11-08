/**
 * The lines a new module adds to files that exist (`docs/MODULE-GUIDE.md`): each at an anchor the file keeps, so a
 * changed file stops the generator and does not let it guess. What can be derived is not here: `MODULES.md` §9 lists it.
 */
import { fill, type Edit, type Names, type Options } from './plan';

const ISSUES_MODULE_IMPORT = "import { issuesModule } from './features/issues/module';\n";
/** Every list of modules takes the new one after issues, so that all of them are in the same order. */
const ISSUES_IN_THE_BUNDLE = '  issuesModule,\n';
const FACTS_IMPORT =
  "import { FACT_HOLD_DAYS_MAX, FACT_SHAPE_FIRST, type FactDeclaration } from './fact-declaration';\n";
const FACTS_LIST = '...CORE_FACTS';
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
const SCHEMA_LAST_FILE =
  'issues/0002_issues_search.sql      issues: the trigram indexes of the folded title and body, for the workspace-wide find  (D-285)\n';
const SCHEMA_SECTION_8 = '## 8. GitHub Integration';
const TREE_ISSUES = "│   │       │   └── issues/      a workspace's issues (D-254)";
/** The end of the list of ids, whatever the number of modules before it. */
const CONFIG_MODULES = '`. **Unset or blank';
const DATA_ISSUES = "| `issues` | A workspace's issue:";
const API_ISSUES = '| ○ | `GET` | `/api/workspaces/:workspaceId/issues` |';
const MODULES_ROW = '| `issues` | — | — | — |\n';
const MODULES_GLOSSARY = '## 12. Glossary';
const ISSUES_AREA = "  { name: 'api-issues', prefixes: ['apps/api/src/features/issues/'] },";
const ISSUES_MUTATIONS_IMPORT = "import { API_ISSUES } from './api-issues';\n";
const ISSUES_MUTATIONS = "  'api-issues': API_ISSUES,";
const CROSS_TENANT_INBOX = "  'GET /api/workspaces/:workspaceId/inbox': {";
const ENDPOINTS_END = '] as const satisfies readonly EndpointSpec[];';

const EDITS: readonly Edit[] = [
  {
    file: 'apps/api/src/composition.ts',
    anchor: ISSUES_MODULE_IMPORT,
    text: `${ISSUES_MODULE_IMPORT}import { __CAMEL__Module } from './features/__ID__/module';\n`,
  },
  {
    file: 'apps/api/src/composition.ts',
    anchor: ISSUES_IN_THE_BUNDLE,
    text: `${ISSUES_IN_THE_BUNDLE}  __CAMEL__Module,\n`,
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
    file: 'packages/types/src/facts.ts',
    anchor: FACTS_IMPORT,
    text: `${FACTS_IMPORT}import { __UPPER___FACTS } from './__ID__';\n`,
  },
  {
    file: 'packages/types/src/facts.ts',
    anchor: FACTS_LIST,
    text: `${FACTS_LIST}, ...__UPPER___FACTS`,
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
  {
    file: 'scripts/mutations/areas.ts',
    anchor: ISSUES_AREA,
    text: `${ISSUES_AREA}\n  { name: 'api-__ID__', prefixes: ['apps/api/src/features/__ID__/'] },`,
  },
  {
    file: 'scripts/mutations/index.ts',
    anchor: ISSUES_MUTATIONS_IMPORT,
    text: `${ISSUES_MUTATIONS_IMPORT}import { API___UPPER__ } from './api-__ID__';\n`,
  },
  {
    file: 'scripts/mutations/index.ts',
    anchor: ISSUES_MUTATIONS,
    text: `${ISSUES_MUTATIONS}\n  'api-__ID__': API___UPPER__,`,
  },
  {
    file: 'apps/api/src/testing/cross-tenant.ts',
    anchor: CROSS_TENANT_INBOX,
    text: `  'GET /api/workspaces/:workspaceId/__ID__': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: { kind: 'none', reason: 'the workspace’s own list; no channel is named or listed' },
  },
  'POST /api/workspaces/:workspaceId/__ID__': {
    refusal: 'WORKSPACE_NOT_FOUND',
    body: () => ({ title: 'Crossing' }),
    visibility: { kind: 'none', reason: 'the workspace’s own list; no channel is named or listed' },
  },
${CROSS_TENANT_INBOX}`,
  },
  {
    file: 'docs/SCHEMA.md',
    anchor: SCHEMA_LAST_FILE,
    text: `${SCHEMA_LAST_FILE}__ID__/0001___ID__.sql             __SNAKE__: a workspace's rows, the __ID__ module's set  (D-__DECISION__)\n`,
  },
  {
    file: 'docs/SCHEMA.md',
    anchor: SCHEMA_SECTION_8,
    text: `**\`__SNAKE__\`** (the __ID__ module's set, \`__ID__/0001\`): a workspace's rows. The keys run to the core only (D-250); the table
exists where the module's set was applied.

\`\`\`sql
CREATE TABLE __SNAKE__ (
    id           UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title        TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx___SNAKE___workspace ON __SNAKE__ (workspace_id, id DESC);
\`\`\`

${SCHEMA_SECTION_8}`,
  },
  {
    file: 'docs/ARCHITECTURE.md',
    anchor: TREE_ISSUES,
    text: `│   │       │   ├── __ID__/       a workspace's rows (D-__DECISION__): its manifest and data hooks, with a migration
│   │       │   │              set of its own (\`packages/db/migrations/__ID__/\`)
${TREE_ISSUES}`,
  },
  {
    file: 'docs/CONFIG.md',
    anchor: CONFIG_MODULES,
    text: '`, `__ID__`. **Unset or blank',
  },
  {
    file: 'docs/DATA.md',
    anchor: DATA_ISSUES,
    text: `| \`__SNAKE__\` | A workspace's row: a title | The __ID__ module, run only where the operator chose it (D-__DECISION__) | Until the workspace is deleted; names no person, so an erasure leaves it |\n${DATA_ISSUES}`,
  },
  {
    file: 'docs/API.md',
    anchor: API_ISSUES,
    text: `| ○ | \`GET\` | \`/api/workspaces/:workspaceId/__ID__\` | Member — the __ID__ module's rows, newest first (D-__DECISION__). |
| ○ | \`POST\` | \`/api/workspaces/:workspaceId/__ID__\` | Member — \`Create__PASCAL__ItemRequest\`: \`title\`, one line of at most \`__UPPER___TITLE_MAX\` characters; \`201\` with the row. |
${API_ISSUES}`,
  },
  {
    file: 'docs/MODULES.md',
    anchor: MODULES_ROW,
    text: `${MODULES_ROW}| \`__ID__\` | __REQUIRES_CELL__ | __OPTIONAL_CELL__ | — |\n`,
  },
  {
    file: 'docs/MODULES.md',
    anchor: MODULES_GLOSSARY,
    text: `### \`__ID__\`

Made by \`bun run module:new __ID__\` (D-__DECISION__, \`docs/MODULE-GUIDE.md\`): a workspace's rows, each a title. **Requires** __REQUIRES_CELL__,
**optional** __OPTIONAL_CELL__, **provides** nothing.

- **Migration set.** \`migrations/__ID__/0001___ID__.sql\`, one table, \`__SNAKE__\`, owned by \`__ID__\`; its keys go to \`workspaces\` only.
- **Removal threshold.** <<FILL>> say when this module is removed from the build, or \`none, because …\` (D-250 rule 6).

${MODULES_GLOSSARY}`,
  },
  {
    file: 'docs/DECISIONS.md',
    text: `
### D-__DECISION__. <<FILL>> the title of the decision: what __ID__ is — builds on D-250

**Context.** <<FILL>> why the module exists.

**Decision.** <<FILL>> what it is, what it is not, the table, who may do what, what becomes of its data when it is off.
The module is described in \`MODULES.md\` §11 and was made by \`bun run module:new __ID__\`.

**Rejected.** <<FILL>>

**Cost of reversing.** <<FILL>>
`,
  },
];

/** The edits of a module called `names`, in the order they are made. */
export const editsFor = (names: Names, options: Options): Edit[] =>
  EDITS.map((edit) => ({ ...edit, text: fill(edit.text, names, options) }));

/** The README says how many decisions there are, and `check:docs` holds it: the new skeleton is the last of them. */
export const readmeCount = (readme: string, decision: number): Edit => {
  const said = /— \d+ decisions/.exec(readme)?.[0] ?? '— decisions';
  return { file: 'README.md', anchor: said, text: `— ${String(decision)} decisions` };
};
