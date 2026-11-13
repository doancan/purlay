/**
 * Which columns the source filters, orders and joins by, read from the TypeScript of the queries.
 *
 * A static, syntactic scan (no type checker): it finds Kysely's `.where`, `.whereRef`, `.orderBy` and
 * the join forms whose column is a string literal, and works out the table from the chain the call hangs
 * on. What it resolves is unambiguous; what it cannot see is counted, not guessed (`Blind`):
 *
 * - a column that is not a literal (`where(sql`...`)`, `orderBy(expression)`, a name in a variable);
 * - a `where((eb) => ...)` callback, whose columns sit inside `eb(...)`;
 * - a chain that starts from a parameter or a helper's return value, whose tables are not in sight;
 * - a name that is a CTE, a subquery alias or a select alias, which no table owns;
 * - raw `sql` templates, whose text is not parsed.
 *
 * The scan is pure; the table's real columns and indexes come from the migrated database in the test
 * that uses it (`query-columns.integration.test.ts`).
 */
import ts from 'typescript';

type Clause = 'where' | 'orderBy' | 'join';

/** One table a chain reads, with the name its columns are qualified by. */
interface ScopeTable {
  readonly table: string;
  readonly alias: string;
}

export interface ColumnReference {
  readonly file: string;
  readonly line: number;
  readonly clause: Clause;
  /** As written: `'issues.status'` or `'status'`. */
  readonly written: string;
  readonly scope: readonly ScopeTable[];
  /** Which statement of the file this is in, so that one query's columns can be read together. */
  readonly query: string;
}

type BlindKind = 'not-a-literal' | 'callback' | 'unknown-chain' | 'raw-sql';

interface Blind {
  readonly file: string;
  readonly line: number;
  readonly kind: BlindKind;
}

export interface Scan {
  readonly references: readonly ColumnReference[];
  readonly blind: readonly Blind[];
}

export interface ResolvedColumn {
  readonly table: string;
  readonly column: string;
}

/** A query through a module table that this schema has never installed cannot run in this cell.
 * Unknown tables and missing core tables still belong to the unresolved-reference guard. */
export const relevantToSchema = (
  reference: ColumnReference,
  present: ReadonlyMap<string, ReadonlySet<string>>,
  owners: Readonly<Record<string, string>>,
): boolean =>
  !reference.scope.some(({ table }) => {
    const owner = owners[table];
    return owner !== undefined && owner !== 'core' && !present.has(table);
  });

const ROOT_METHODS = new Set(['selectFrom', 'updateTable', 'deleteFrom', 'insertInto', 'from']);
const JOIN_METHODS = new Set([
  'innerJoin',
  'leftJoin',
  'rightJoin',
  'fullJoin',
  'innerJoinLateral',
  'leftJoinLateral',
]);

const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAwaitExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const literalOf = (node: ts.Node | undefined): string | undefined =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;

const scopeTable = (written: string): ScopeTable => {
  const [table = written, alias = table] = written.split(/\s+as\s+/i);
  return { table, alias };
};

const bindingHasName = (binding: ts.BindingName, name: string): boolean =>
  ts.isIdentifier(binding)
    ? binding.text === name
    : binding.elements.some(
        (element) => !ts.isOmittedExpression(element) && bindingHasName(element.name, name),
      );

/** Resolve a local initializer only before the nearest lexical binding of that name. */
const declaredInitializer = (name: string, from: ts.Node): ts.Expression | undefined => {
  let parent = from.parent;
  for (;;) {
    if (ts.isSourceFile(parent) || ts.isBlock(parent)) {
      for (const statement of parent.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (bindingHasName(declaration.name, name))
              return ts.isIdentifier(declaration.name) ? declaration.initializer : undefined;
          }
        } else if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === name
        )
          return undefined;
      }
    }
    if (
      ts.isFunctionLike(parent) &&
      parent.parameters.some((parameter) => bindingHasName(parameter.name, name))
    )
      return undefined;
    if (ts.isFunctionExpression(parent) && parent.name?.text === name) return undefined;
    if (
      ts.isCatchClause(parent) &&
      parent.variableDeclaration !== undefined &&
      bindingHasName(parent.variableDeclaration.name, name)
    )
      return undefined;
    if (
      (ts.isForStatement(parent) || ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
      parent.initializer !== undefined &&
      ts.isVariableDeclarationList(parent.initializer) &&
      parent.initializer.declarations.some((declaration) => bindingHasName(declaration.name, name))
    )
      return undefined;
    if (ts.isSourceFile(parent)) return undefined;
    parent = parent.parent;
  }
};

interface JoinChain {
  readonly builder: string;
  readonly calls: ReadonlySet<ts.CallExpression>;
}
const JOIN_CHAIN_METHODS = new Set(['on', 'onRef', 'onTrue']);
const FILTER_CHAIN_METHODS = new Set(['where', 'whereRef']);

/** Only explicit scope-preserving builder methods retain the receiver's provenance. */
const methodChainOf = (
  expression: ts.Expression,
  methods: ReadonlySet<string> = JOIN_CHAIN_METHODS,
): JoinChain | undefined => {
  let current = unwrap(expression);
  const calls = new Set<ts.CallExpression>();
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    if (!methods.has(current.expression.name.text)) return undefined;
    calls.add(current);
    current = unwrap(current.expression.expression);
  }
  return ts.isIdentifier(current) ? { builder: current.text, calls } : undefined;
};

const returnedBody = (
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | undefined => {
  const body = callback.body;
  const only = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : undefined;
  return ts.isBlock(body)
    ? only !== undefined && ts.isReturnStatement(only)
      ? only.expression
      : undefined
    : body;
};

/** A conditional filter may add predicates but cannot substitute another query. */
const keepsFilterScope = (callback: ts.Expression | undefined): boolean => {
  if (
    callback === undefined ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
  )
    return false;
  const parameter = callback.parameters[0]?.name;
  const returned = returnedBody(callback);
  if (parameter === undefined || !ts.isIdentifier(parameter) || returned === undefined)
    return false;
  return methodChainOf(returned, FILTER_CHAIN_METHODS)?.builder === parameter.text;
};

/** The tables a chain reads, and the position its first call starts at: what tells one query from the next. */
interface Chain {
  readonly tables: ScopeTable[];
  readonly root: number;
}

/** The chain a call hangs on, or `undefined` when it starts somewhere unseen. */
const chainOf = (
  start: ts.Expression,
  seen: ReadonlySet<ts.Node> = new Set(),
): Chain | undefined => {
  const tables: ScopeTable[] = [];
  let root: number | undefined;
  let current: ts.Expression = unwrap(start);
  for (;;) {
    if (ts.isIdentifier(current)) {
      const initializer = declaredInitializer(current.text, current);
      if (initializer === undefined || seen.has(initializer)) break;
      const inherited = chainOf(initializer, new Set(seen).add(initializer));
      if (inherited !== undefined) {
        return { tables: [...tables, ...inherited.tables], root: inherited.root };
      }
      root ??= current.getStart();
      break;
    }
    if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) {
      root ??= current.getStart();
      break;
    }
    const method = current.expression.name.text;
    if (
      method.startsWith('$') &&
      method !== '$castTo' &&
      !(method === '$if' && keepsFilterScope(current.arguments[1]))
    ) {
      root = current.getEnd();
      break;
    }
    const first = literalOf(current.arguments[0]);
    if ((ROOT_METHODS.has(method) || JOIN_METHODS.has(method)) && first !== undefined) {
      tables.push(scopeTable(first));
    }
    root = current.getStart();
    current = unwrap(current.expression.expression);
  }
  return root !== undefined ? { tables, root } : undefined;
};

/** An upsert guard probes its declared unique key first; it is not a scan by the guard column alone. */
const conflictOf = (
  receiver: ts.Expression,
  from: ts.Node,
): { readonly chain: Chain; readonly columns: readonly ts.Expression[] } | undefined => {
  let current = unwrap(receiver);
  let columns: readonly ts.Expression[] | undefined;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const first = current.arguments[0];
    const method = current.expression.name.text;
    if (method === 'columns' && first !== undefined && ts.isArrayLiteralExpression(first))
      columns = first.elements;
    else if (method === 'column' && first !== undefined) columns = [first];
    current = unwrap(current.expression.expression);
  }
  if (!ts.isIdentifier(current) || columns === undefined) return undefined;
  let parent = from.parent;
  while (!ts.isSourceFile(parent)) {
    if (
      ts.isCallExpression(parent) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      parent.expression.name.text === 'onConflict'
    ) {
      const callback = parent.arguments[0];
      if (
        callback !== undefined &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        const name = callback.parameters[0]?.name;
        if (name !== undefined && ts.isIdentifier(name) && name.text === current.text) {
          const chain = chainOf(parent.expression.expression);
          if (chain !== undefined) return { chain, columns };
        }
      }
    }
    parent = parent.parent;
  }
  return undefined;
};

/** A callback supplies scope only for its own directly returned, unchanged join chain. */
const joinOf = (from: ts.CallExpression): Chain | undefined => {
  const source = methodChainOf(from);
  if (source === undefined) return undefined;
  const builderName = source.builder;
  let parent = from.parent;
  while (!ts.isSourceFile(parent)) {
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
      const parameter = parent.parameters.find(
        ({ name }) => ts.isIdentifier(name) && name.text === builderName,
      );
      if (parameter !== undefined) {
        const owner = parent.parent;
        if (
          parent.parameters[0] === parameter &&
          ts.isCallExpression(owner) &&
          ts.isPropertyAccessExpression(owner.expression) &&
          JOIN_METHODS.has(owner.expression.name.text) &&
          literalOf(owner.arguments[0]) !== undefined &&
          owner.arguments[1] === parent
        ) {
          const returned = returnedBody(parent);
          const callback = returned === undefined ? undefined : methodChainOf(returned);
          if (callback?.builder !== builderName || !callback.calls.has(from)) return undefined;
          return chainOf(owner);
        }
        return undefined;
      }
    }
    parent = parent.parent;
  }
  return undefined;
};

const SIMPLE_REFERENCE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i;

const lineOf = (source: ts.SourceFile, node: ts.Node): number =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/** Reads one file. `file` is only the name the findings carry. */
export const scanSource = (file: string, text: string): Scan => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const references: ColumnReference[] = [];
  const blind: Blind[] = [];

  const note = (node: ts.Node, kind: BlindKind): void => {
    blind.push({ file, line: lineOf(source, node), kind });
  };

  const take = (
    call: ts.CallExpression,
    argument: ts.Expression | undefined,
    clause: Clause,
    chain: Chain | undefined,
    joined?: ScopeTable,
  ): void => {
    if (argument === undefined) return;
    const written = literalOf(argument);
    if (written === undefined) {
      note(
        argument,
        ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
          ? 'callback'
          : 'not-a-literal',
      );
      return;
    }
    if (!SIMPLE_REFERENCE.test(written)) {
      note(argument, 'not-a-literal');
      return;
    }
    const scope = [...(chain?.tables ?? []), ...(joined === undefined ? [] : [joined])];
    if (scope.length === 0 && !written.includes('.')) {
      note(call, 'unknown-chain');
      return;
    }
    const queryKey =
      chain === undefined
        ? `unknown:${String(call.expression.getEnd())}`
        : `query:${String(chain.root)}`;
    references.push({
      file,
      line: lineOf(source, argument),
      clause,
      written,
      scope,
      query: `${file}:${queryKey}`,
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      node.tag.text === 'sql'
    ) {
      note(node, 'raw-sql');
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const [first, second, third] = node.arguments;
      const isQuery =
        method === 'where' ||
        method === 'whereRef' ||
        method === 'having' ||
        method === 'orderBy' ||
        JOIN_METHODS.has(method) ||
        method === 'on' ||
        method === 'onRef';
      if (isQuery) {
        const conflict =
          method === 'where' || method === 'whereRef' || method === 'having'
            ? conflictOf(node.expression.expression, node)
            : undefined;
        const chain =
          method === 'on' || method === 'onRef'
            ? joinOf(node)
            : (conflict?.chain ?? chainOf(node.expression.expression));
        if (conflict !== undefined)
          for (const column of conflict.columns) take(node, column, 'where', chain);
        if (method === 'where' || method === 'having') take(node, first, 'where', chain);
        else if (method === 'whereRef') {
          take(node, first, 'where', chain);
          take(node, third, 'where', chain);
        } else if (method === 'orderBy') take(node, first, 'orderBy', chain);
        else if (JOIN_METHODS.has(method)) {
          // The joined table is in scope for its own on-clause.
          const table = literalOf(first);
          const joined = table === undefined ? undefined : scopeTable(table);
          if (second !== undefined && ts.isStringLiteralLike(second)) {
            take(node, second, 'join', chain, joined);
            take(node, third, 'join', chain, joined);
          } else if (second !== undefined) note(second, 'callback');
        } else if (method === 'on') take(node, first, 'join', chain);
        else {
          take(node, first, 'join', chain);
          take(node, third, 'join', chain);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { references, blind };
};

/**
 * The table and column a reference names, when exactly one table can own it.
 * `columns` is every real table with its columns, read from the database.
 */
export const resolveReference = (
  reference: ColumnReference,
  columns: ReadonlyMap<string, ReadonlySet<string>>,
): ResolvedColumn | undefined => {
  const [qualifier, name] = reference.written.includes('.')
    ? (reference.written.split('.') as [string, string])
    : [undefined, reference.written];
  if (qualifier !== undefined) {
    const aliased = reference.scope.find((entry) => entry.alias === qualifier)?.table;
    const table = aliased ?? (columns.has(qualifier) ? qualifier : undefined);
    return table !== undefined && columns.get(table)?.has(name) === true
      ? { table, column: name }
      : undefined;
  }
  const owners = reference.scope
    .map((entry) => entry.table)
    .filter((table) => columns.get(table)?.has(name) === true);
  const [only, ...rest] = [...new Set(owners)];
  return only !== undefined && rest.length === 0 ? { table: only, column: name } : undefined;
};
