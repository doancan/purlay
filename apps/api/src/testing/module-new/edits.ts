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
const MODULES_ROW = '| `issues` | — | — | `issues.records` |\n';
const MODULES_GLOSSARY = '## 12. Glossary';
const ISSUES_AREA = "  { name: 'api-issues', prefixes: ['apps/api/src/features/issues/'] },";
const ISSUES_MUTATIONS_IMPORT = "import { API_ISSUES } from './api-issues';\n";
const ISSUES_MUTATIONS = "  'api-issues': API_ISSUES,";
const CROSS_TENANT_INBOX = "  'GET /api/workspaces/:workspaceId/inbox': {";
const ENDPOINTS_END = '] as const satisfies readonly EndpointSpec[];';

const WEB_REGISTRY_IMPORT = "import { issues } from '../features/issues/manifest';\n";
/** The end of the list of manifests, whatever the number of modules before it. */
const WEB_REGISTRY_LIST = '] as const;\n\nexport type ModuleManifestOf';
const WEB_API_IMPORT = "import { createIssuesApi, type IssuesApi } from './endpoints/issues';\n";
const WEB_API_EXTENDS = '    IssuesApi,\n';
const WEB_API_SPREAD = '  ...createIssuesApi(http),\n';
const WEB_FAKE_API = "  deleteIssue: unexpected('deleteIssue'),\n";
const WEB_KEY = "  issues: (workspaceId: string) => ['issues', workspaceId] as const,\n";
const WEB_ACCESS = "  keys.issues('')[0],\n";
const WEB_ROUTE_OWNER = "  issues: 'issues',\n";
const WEB_WORDS_EN = "  'issues.more': 'Load more',\n";
const WEB_WORDS_TR = "  'issues.more': 'Daha fazla yükle',\n";

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
    file: 'apps/web/src/modules/registry.ts',
    anchor: WEB_REGISTRY_IMPORT,
    text: `${WEB_REGISTRY_IMPORT}import { __CAMEL__ } from '../features/__ID__/manifest';\n`,
  },
  {
    file: 'apps/web/src/modules/registry.ts',
    anchor: WEB_REGISTRY_LIST,
    // `[a, b] as const` on one line, or one to a line with a comma after the last once it is too long for one.
    text: (before) =>
      `${before.trimEnd().endsWith(',') ? '  __CAMEL__,\n' : ', __CAMEL__'}${WEB_REGISTRY_LIST}`,
  },
  {
    file: 'apps/web/src/data/api.ts',
    anchor: WEB_API_IMPORT,
    text: `${WEB_API_IMPORT}import { create__PASCAL__Api, type __PASCAL__Api } from './endpoints/__ID__';\n`,
  },
  {
    file: 'apps/web/src/data/api.ts',
    anchor: WEB_API_EXTENDS,
    text: `${WEB_API_EXTENDS}    __PASCAL__Api,\n`,
  },
  {
    file: 'apps/web/src/data/api.ts',
    anchor: WEB_API_SPREAD,
    text: `${WEB_API_SPREAD}  ...create__PASCAL__Api(http),\n`,
  },
  {
    file: 'apps/web/src/testing/fake-api.ts',
    anchor: WEB_FAKE_API,
    text: `${WEB_FAKE_API}  list__PASCAL__: unexpected('list__PASCAL__'),\n  create__PASCAL__Item: unexpected('create__PASCAL__Item'),\n`,
  },
  {
    file: 'apps/web/src/data/keys.ts',
    anchor: WEB_KEY,
    text: `${WEB_KEY}  /** A workspace's __ID__ rows (the module's list). */\n  __CAMEL__: (workspaceId: string) => ['__ID__', workspaceId] as const,\n`,
  },
  {
    // A workspace's content is forgotten when its access changes, and a module's rows are workspace content.
    file: 'apps/web/src/data/access-change.ts',
    anchor: WEB_ACCESS,
    text: `${WEB_ACCESS}  keys.__CAMEL__('')[0],\n`,
  },
  {
    file: 'apps/web/src/router/route-modules.test.ts',
    anchor: WEB_ROUTE_OWNER,
    text: `${WEB_ROUTE_OWNER}  __CAMEL__: '__ID__',\n`,
  },
  {
    file: 'apps/web/src/i18n/catalogue/en.ts',
    anchor: WEB_WORDS_EN,
    text: `${WEB_WORDS_EN}  '__ID__.title': '__TITLE__',
  '__ID__.loading': 'Loading __LOWER__',
  '__ID__.error.title': '__TITLE__ could not be loaded',
  '__ID__.error.body': 'The server did not answer. Nothing was lost.',
  '__ID__.empty.title': 'Nothing here yet',
  '__ID__.empty.body': 'Write a title above and press Add.',
  '__ID__.new.title': 'New item',
  '__ID__.new.placeholder': 'What is it called?',
  '__ID__.new.add': 'Add',
  '__ID__.new.failed': 'It was not added.',
`,
  },
  {
    file: 'apps/web/src/i18n/catalogue/tr.ts',
    anchor: WEB_WORDS_TR,
    text: `${WEB_WORDS_TR}  '__ID__.title': '__TITLE__', // <<FILL>> say the title in Turkish
  '__ID__.loading': 'Yükleniyor: __LOWER__', // <<FILL>> say it in Turkish
  '__ID__.error.title': '__TITLE__ yüklenemedi', // <<FILL>> say it in Turkish
  '__ID__.error.body': 'Sunucu yanıt vermedi. Hiçbir şey kaybolmadı.',
  '__ID__.empty.title': 'Henüz bir şey yok',
  '__ID__.empty.body': 'Yukarıya bir başlık yazın ve Ekle’ye basın.',
  '__ID__.new.title': 'Yeni öğe',
  '__ID__.new.placeholder': 'Adı ne?',
  '__ID__.new.add': 'Ekle',
  '__ID__.new.failed': 'Eklenemedi.',
`,
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
];

/** The edits of a module called `names`, in the order they are made. */
export const editsFor = (names: Names, options: Options): Edit[] =>
  EDITS.map((edit) => ({
    ...edit,
    text:
      typeof edit.text === 'function'
        ? (
            (write: (before: string) => string) => (before: string) =>
              fill(write(before), names, options)
          )(edit.text)
        : fill(edit.text, names, options),
  }));

/** The README says how many decisions there are, and `check:docs` holds it: the new skeleton is the last of them. */
export const readmeCount = (readme: string, decision: number): Edit => {
  const said = /— \d+ decisions/.exec(readme)?.[0] ?? '— decisions';
  return { file: 'README.md', anchor: said, text: `— ${String(decision)} decisions` };
};
