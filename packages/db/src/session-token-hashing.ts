/**
 * Keeps the raw session token out of `sessions.token_hash` when Better Auth writes and reads it
 * (D-11, D-179 §3). Applied with `withPlugin` to the one Kysely instance handed to the library, so
 * the library keeps talking in raw tokens and the table keeps holding only their SHA-256 — a dump
 * is not a session, with the secret or without it.
 *
 * - **Every value bound to `sessions.token_hash` leaves hashed**: an INSERT's values, an UPDATE's
 *   SET, the value a WHERE compares it with (either side, `=`, `<>`, `IN`), in a join, a subquery or
 *   under an alias. A value that already looks like a digest is hashed again: passing it through
 *   would let a dumped hash, signed with the secret, work as a cookie (the spike's C5).
 * - **A row read by the raw token gets that raw token back**, so the library re-signs the same
 *   cookie on a refresh and hands the new one out on a create. A row read any other way (by user,
 *   by id) keeps its digest. The map from digest to token lives for one query.
 * - **Only `sessions`.** `workspace_invitations.token_hash` has the same name and is already a
 *   digest of its own (D-115); a query that does not name `sessions` is not touched at all.
 * - **What it cannot read on `sessions` is refused, not guessed at.** A statement *reaches
 *   `sessions`* when it names it as an identifier (a builder's table, `sql.table`, `sql.id`, quoted,
 *   schema-qualified, in any case) or when the text of its raw SQL — fragments joined with their
 *   parameters, so a name split across `sql.raw` pieces is read whole — contains `sessions`. In such
 *   a statement it throws on:
 *   - a whole raw statement, whatever it binds or names (a split name, an escaped identifier, a
 *     column named by a value cannot all be read, so none is tried);
 *   - a raw fragment inside a builder statement that binds a value, or that names `token_hash`;
 *   - an INSERT into `sessions` with no column list, and every INSERT … SELECT into it;
 *   - MERGE;
 *   - `token_hash` reached through a derived table, a common table expression or a table function,
 *     under an unknown qualifier, unqualified where a subquery leaves its table ambiguous, under an
 *     operator other than (in)equality, `IN` or `IS`, compared with something that is not a value, or
 *     anywhere that is not a select list, RETURNING, ORDER BY, GROUP BY or ON CONFLICT target.
 *   Each would otherwise risk sending a raw token to the table, which is the one failure this exists
 *   to prevent. Better Auth 1.7.12 issues none of them on `sessions` (the auth module's tests run
 *   every path it uses, its schema check included); an upgrade that starts to is a loud error.
 *
 * What it does not guarantee. A statement that reaches `sessions` without naming it is not seen: a
 * view or a function over the table, Postgres-side dynamic SQL (`EXECUTE`, a `DO` block building
 * the name), or a name spelt with a Unicode escape (`U&"sess\0069ons"`). A raw fragment that binds no
 * value but spells a token as a literal in its text is not read for one. None of these exists in
 * this repository or in the library, and the instance this is applied to is the library's alone.
 */
import { createHash } from 'node:crypto';
import {
  OperationNodeTransformer,
  type BinaryOperationNode,
  type ColumnUpdateNode,
  type DeleteQueryNode,
  type InsertQueryNode,
  type KyselyPlugin,
  type MergeQueryNode,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryId,
  type QueryResult,
  type ReferenceNode,
  type RootOperationNode,
  type SelectQueryNode,
  type UnknownRow,
  type UpdateQueryNode,
  type ColumnNode,
  type RawNode,
} from 'kysely';

const TABLE = 'sessions';
const COLUMN = 'token_hash';

/** What `sessions.token_hash` holds for a token: the scheme `platform/tokens.ts` names, hex SHA-256. */
export const sessionTokenDigest = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export class SessionTokenHashingError extends Error {
  constructor(what: string) {
    super(`session-token hashing: ${what} — refused rather than sent with a raw token`);
    this.name = 'SessionTokenHashingError';
  }
}

/** A table a query names in one scope: a real one by its name, or one this plugin cannot see into. */
type Source = { readonly table: string } | 'derived';

/** The tables one SELECT, UPDATE, DELETE or INSERT reads from, by the name or alias it uses. */
type Scope = ReadonlyMap<string, Source>;

/** Lets the walk below read any node's fields without a cast at each step. */
type Loose = Readonly<Record<string, unknown>>;
const fields = (node: OperationNode): Loose => node as unknown as Loose;

const isNode = (value: unknown): value is OperationNode =>
  typeof value === 'object' && value !== null && typeof (value as Loose)['kind'] === 'string';

const identifierOf = (node: unknown): string | undefined => {
  if (!isNode(node)) return undefined;
  const loose = fields(node);
  if (node.kind === 'IdentifierNode') return loose['name'] as string;
  if (node.kind === 'TableNode') return identifierOf((loose['table'] as Loose)['identifier']);
  return undefined;
};

/** Every node under `root`, depth first. Used once per query, before anything is transformed. */
const everyNode = function* (root: unknown): Generator<OperationNode> {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) stack.push(...(value as unknown[]));
    else if (isNode(value)) {
      yield value;
      for (const child of Object.values(fields(value))) {
        if (typeof child === 'object' && child !== null) stack.push(child);
      }
    }
  }
};

interface Survey {
  /** Whether `sessions` is named anywhere: as a table, an identifier, or in raw SQL's text. */
  readonly sessions: boolean;
  readonly cteNames: ReadonlySet<string>;
  readonly rawNamesColumn: boolean;
}

/** Whether a raw fragment names the column: in its text, or through `sql.ref`, `sql.id` or `sql.table`. */
const rawNamesColumn = (raw: OperationNode): boolean => {
  for (const node of everyNode(raw)) {
    if (node.kind === 'RawNode') {
      if (/token_hash/i.test((fields(node)['sqlFragments'] as readonly string[]).join(' '))) {
        return true;
      }
    }
    if (node.kind === 'IdentifierNode' && fields(node)['name'] === COLUMN) return true;
  }
  return false;
};

/**
 * A raw node's SQL as far as it can be read without a compiler: its fragments, with each parameter
 * spelt where it stands — an identifier or a table by its name, a nested raw node by its own text, a
 * bound value as `?`. Lower case and without quotes, so `sess${sql.raw('ions')}` and
 * `public."SESSIONS"` both read as naming `sessions`.
 */
const rawText = (node: OperationNode): string => {
  const loose = fields(node);
  if (node.kind === 'RawNode') {
    const fragments = loose['sqlFragments'] as readonly unknown[];
    const parameters = loose['parameters'] as readonly OperationNode[];
    return fragments
      .map((fragment, at) => {
        const parameter = parameters[at];
        const text = typeof fragment === 'string' ? fragment : '';
        return parameter === undefined ? text : `${text}${rawText(parameter)}`;
      })
      .join('');
  }
  if (node.kind === 'IdentifierNode') return String(loose['name']);
  // A table, a reference, a column: the names it is made of, in order; anything else binds.
  const names = [...everyNode(node)]
    .filter((each) => each.kind === 'IdentifierNode')
    .map((each) => String(fields(each)['name']));
  return names.length > 0 ? names.join('.') : '?';
};

const readsAsSessions = (text: string): boolean =>
  text.toLowerCase().replace(/"/g, '').includes(TABLE);

/** Whether a node binds a value anywhere under it: a raw fragment that does is unreadable here. */
const bindsAValue = (node: OperationNode): boolean =>
  [...everyNode(node)].some(
    (each) =>
      each.kind === 'ValueNode' ||
      each.kind === 'ValueListNode' ||
      each.kind === 'PrimitiveValueListNode',
  );

const survey = (root: OperationNode): Survey => {
  let sessions = false;
  let rawColumn = false;
  const cteNames = new Set<string>();
  for (const node of everyNode(root)) {
    // An identifier however it was written: a builder's table, `sql.table`, `sql.id`.
    if (node.kind === 'IdentifierNode' && String(fields(node)['name']).toLowerCase() === TABLE) {
      sessions = true;
    }
    if (node.kind === 'CommonTableExpressionNameNode') {
      const name = identifierOf(fields(node)['table']);
      if (name !== undefined) cteNames.add(name);
    }
    if (node.kind === 'RawNode') {
      // A fragment a template could not cook (an invalid escape) cannot be read at all: as if it named it.
      const unreadable = (fields(node)['sqlFragments'] as readonly unknown[]).some(
        (fragment) => typeof fragment !== 'string',
      );
      if (unreadable || readsAsSessions(rawText(node))) sessions = true;
      if (!rawColumn && rawNamesColumn(node)) rawColumn = true;
    }
  }
  return { sessions, cteNames, rawNamesColumn: rawColumn };
};

/** Where a read of the column carries no value to hash: a select list, a RETURNING, an ORDER BY. */
const READING_PARENTS: ReadonlySet<string> = new Set([
  'SelectionNode',
  'ReturningNode',
  'OrderByItemNode',
  'GroupByItemNode',
  'OnConflictNode',
]);

const COMPARISONS: ReadonlySet<string> = new Set(['=', '<>', '!=', 'in', 'not in', 'is', 'is not']);

class Hasher extends OperationNodeTransformer {
  private readonly scopes: Scope[] = [];
  /** Column nodes already handled where they carry a value, so the reference check passes them. */
  private readonly handled = new WeakSet<OperationNode>();

  private readonly cteNames: ReadonlySet<string>;
  private readonly seen: Map<string, string>;

  constructor(cteNames: ReadonlySet<string>, seen: Map<string, string>) {
    super();
    this.cteNames = cteNames;
    this.seen = seen;
  }

  private sourceOf(node: OperationNode | undefined): [string, Source] | undefined {
    if (node === undefined) return undefined;
    if (node.kind === 'TableNode') {
      const name = identifierOf(node) ?? '';
      return [name, this.cteNames.has(name) ? 'derived' : { table: name }];
    }
    if (node.kind === 'AliasNode') {
      const loose = fields(node);
      const alias = identifierOf(loose['alias']) ?? '';
      const inner = this.sourceOf(loose['node'] as OperationNode);
      return [alias, inner === undefined ? 'derived' : inner[1]];
    }
    // A function in FROM, a VALUES list: nothing this plugin can see the columns of.
    return ['', 'derived'];
  }

  private scopeOf(nodes: readonly (OperationNode | undefined)[]): Scope {
    const scope = new Map<string, Source>();
    for (const node of nodes) {
      const source = this.sourceOf(node);
      if (source !== undefined) scope.set(source[0], source[1]);
    }
    return scope;
  }

  private within<T>(scope: Scope, transform: () => T): T {
    this.scopes.push(scope);
    try {
      return transform();
    } finally {
      this.scopes.pop();
    }
  }

  /** Whether a `token_hash` named with this qualifier, or none, is `sessions`'s. Throws when unsure. */
  private isSessions(qualifier: string | undefined): boolean {
    const chain = [...this.scopes].reverse();
    if (qualifier !== undefined) {
      for (const scope of chain) {
        const source = scope.get(qualifier);
        if (source === undefined) continue;
        if (source === 'derived') {
          throw new SessionTokenHashingError(
            `\`${qualifier}.${COLUMN}\` comes from a derived table`,
          );
        }
        return source.table === TABLE;
      }
      throw new SessionTokenHashingError(`\`${qualifier}.${COLUMN}\` names no table in scope`);
    }
    const [innermost, ...outer] = chain;
    const sources = [...(innermost?.values() ?? [])];
    if (sources.some((source) => source !== 'derived' && source.table === TABLE)) return true;
    if (sources.includes('derived')) {
      throw new SessionTokenHashingError(`\`${COLUMN}\` may come from a derived table`);
    }
    if (
      outer.some((scope) => [...scope.values()].some((s) => s === 'derived' || s.table === TABLE))
    ) {
      throw new SessionTokenHashingError(`an unqualified \`${COLUMN}\` in a subquery is ambiguous`);
    }
    return false;
  }

  /** Whether this node names `sessions.token_hash`. */
  private isOurs(node: OperationNode): boolean {
    if (node.kind === 'ReferenceNode') {
      const reference = node as ReferenceNode;
      if (reference.column.kind !== 'ColumnNode') return false;
      if (identifierOf(reference.column.column) !== COLUMN) return false;
      return this.isSessions(identifierOf(reference.table));
    }
    if (node.kind === 'ColumnNode') {
      return identifierOf((node as ColumnNode).column) === COLUMN && this.isSessions(undefined);
    }
    return false;
  }

  private hash(value: unknown): unknown {
    if (value === null) return value;
    if (typeof value !== 'string') {
      throw new SessionTokenHashingError(`a ${typeof value} bound to \`${COLUMN}\``);
    }
    const digest = sessionTokenDigest(value);
    this.seen.set(digest, value);
    return digest;
  }

  private hashedValue(node: OperationNode): OperationNode {
    const loose = fields(node);
    if (node.kind === 'ValueNode')
      return { ...node, value: this.hash(loose['value']) } as OperationNode;
    if (node.kind === 'PrimitiveValueListNode') {
      return {
        ...node,
        values: (loose['values'] as readonly unknown[]).map((value) => this.hash(value)),
      } as OperationNode;
    }
    if (node.kind === 'ValueListNode') {
      return {
        ...node,
        values: (loose['values'] as readonly OperationNode[]).map((value) => {
          if (value.kind !== 'ValueNode') {
            throw new SessionTokenHashingError(
              `a ${value.kind} in a list compared with \`${COLUMN}\``,
            );
          }
          return this.hashedValue(value);
        }),
      } as OperationNode;
    }
    throw new SessionTokenHashingError(`\`${COLUMN}\` compared with or set to a ${node.kind}`);
  }

  protected override transformSelectQuery(
    node: SelectQueryNode,
    queryId?: QueryId,
  ): SelectQueryNode {
    const scope = this.scopeOf([
      ...(node.from?.froms ?? []),
      ...(node.joins ?? []).map((j) => j.table),
    ]);
    return this.within(scope, () => super.transformSelectQuery(node, queryId));
  }

  protected override transformDeleteQuery(
    node: DeleteQueryNode,
    queryId?: QueryId,
  ): DeleteQueryNode {
    const scope = this.scopeOf([
      ...node.from.froms,
      ...(node.using?.tables ?? []),
      ...(node.joins ?? []).map((j) => j.table),
    ]);
    return this.within(scope, () => super.transformDeleteQuery(node, queryId));
  }

  protected override transformUpdateQuery(
    node: UpdateQueryNode,
    queryId?: QueryId,
  ): UpdateQueryNode {
    const scope = this.scopeOf([
      node.table,
      ...(node.from?.froms ?? []),
      ...(node.joins ?? []).map((j) => j.table),
    ]);
    return this.within(scope, () => super.transformUpdateQuery(node, queryId));
  }

  protected override transformMergeQuery(): MergeQueryNode {
    throw new SessionTokenHashingError(`MERGE in a statement that names \`${TABLE}\``);
  }

  protected override transformInsertQuery(
    node: InsertQueryNode,
    queryId?: QueryId,
  ): InsertQueryNode {
    const scope = this.scopeOf([node.into]);
    return this.within(scope, () => {
      if (identifierOf(node.into)?.toLowerCase() === TABLE) {
        // What lands in each column is known only from a column list and a VALUES list: without the
        // one, a position may be the token; with a SELECT, any expression may be.
        if ((node.columns ?? []).length === 0) {
          throw new SessionTokenHashingError(`an INSERT into \`${TABLE}\` with no column list`);
        }
        if (node.values?.kind !== 'ValuesNode') {
          throw new SessionTokenHashingError(`INSERT … SELECT into \`${TABLE}\``);
        }
      }
      const at = (node.columns ?? []).findIndex((column) => {
        if (identifierOf(column.column) !== COLUMN) return false;
        return this.isSessions(undefined);
      });
      if (at < 0) return super.transformInsertQuery(node, queryId);
      const column = node.columns?.[at];
      if (column !== undefined) this.handled.add(column);
      const rows = fields(node.values ?? node)['values'] as readonly OperationNode[];
      const values = {
        ...node.values,
        values: rows.map((row) => {
          const items = [...(fields(row)['values'] as readonly unknown[])];
          items[at] =
            row.kind === 'PrimitiveValueListNode'
              ? this.hash(items[at])
              : this.hashedValue(items[at] as OperationNode);
          return { ...row, values: items };
        }),
      } as OperationNode;
      return super.transformInsertQuery({ ...node, values }, queryId);
    });
  }

  protected override transformColumnUpdate(
    node: ColumnUpdateNode,
    queryId?: QueryId,
  ): ColumnUpdateNode {
    if (!this.isOurs(node.column)) return super.transformColumnUpdate(node, queryId);
    this.handled.add(node.column);
    return super.transformColumnUpdate({ ...node, value: this.hashedValue(node.value) }, queryId);
  }

  protected override transformBinaryOperation(
    node: BinaryOperationNode,
    queryId?: QueryId,
  ): BinaryOperationNode {
    const leftOurs = this.isOurs(node.leftOperand);
    const rightOurs = !leftOurs && this.isOurs(node.rightOperand);
    if (!leftOurs && !rightOurs) return super.transformBinaryOperation(node, queryId);
    const operator = fields(node.operator)['operator'];
    if (node.operator.kind !== 'OperatorNode' || !COMPARISONS.has(String(operator))) {
      throw new SessionTokenHashingError(`\`${COLUMN}\` under the operator ${String(operator)}`);
    }
    const [column, value] = leftOurs
      ? [node.leftOperand, node.rightOperand]
      : [node.rightOperand, node.leftOperand];
    this.handled.add(column);
    const hashed = this.hashedValue(value);
    return super.transformBinaryOperation(
      leftOurs ? { ...node, rightOperand: hashed } : { ...node, leftOperand: hashed },
      queryId,
    );
  }

  /** A reference to the column anywhere not handled above, and not merely read, is refused. */
  private checkRead(node: OperationNode): void {
    if (this.handled.has(node) || !this.isOurs(node)) return;
    const parents = this.nodeStack.slice(0, -1).reverse();
    const parent = parents.find(
      (each) => each.kind !== 'AliasNode' && each.kind !== 'ReferenceNode',
    );
    if (parent !== undefined && READING_PARENTS.has(parent.kind)) return;
    throw new SessionTokenHashingError(`\`${COLUMN}\` inside a ${parent?.kind ?? 'statement'}`);
  }

  /** A raw fragment in a statement on `sessions` that binds a value: whose value it is cannot be read. */
  protected override transformRaw(node: RawNode, queryId?: QueryId): RawNode {
    if (bindsAValue(node)) {
      throw new SessionTokenHashingError(
        `a raw fragment binding a value in a statement on \`${TABLE}\``,
      );
    }
    return super.transformRaw(node, queryId);
  }

  protected override transformReference(node: ReferenceNode, queryId?: QueryId): ReferenceNode {
    this.checkRead(node);
    return super.transformReference(node, queryId);
  }

  protected override transformColumn(node: ColumnNode, queryId?: QueryId): ColumnNode {
    // A column inside a reference was judged with its qualifier, above.
    if (this.nodeStack.at(-2)?.kind !== 'ReferenceNode') this.checkRead(node);
    return super.transformColumn(node, queryId);
  }
}

/**
 * The plugin. One per instance is enough: what it keeps between a query and its result is keyed by
 * that query and dropped when the result is read.
 */
export const sessionTokenHashing = (): KyselyPlugin => {
  const perQuery = new WeakMap<QueryId, Map<string, string>>();
  return {
    transformQuery: (args: PluginTransformQueryArgs): RootOperationNode => {
      const found = survey(args.node);
      if (!found.sessions) return args.node;
      // A whole raw statement that reaches `sessions` is not read for what it binds, because no
      // reading of it can be complete; it is refused.
      if (args.node.kind === 'RawNode') {
        throw new SessionTokenHashingError(`a raw statement on \`${TABLE}\``);
      }
      if (found.rawNamesColumn) {
        throw new SessionTokenHashingError(
          `raw SQL naming \`${COLUMN}\` in a statement on \`${TABLE}\``,
        );
      }
      const seen = new Map<string, string>();
      const node = new Hasher(found.cteNames, seen).transformNode(args.node, args.queryId);
      if (seen.size > 0) perQuery.set(args.queryId, seen);
      return node;
    },
    transformResult: (args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> => {
      const seen = perQuery.get(args.queryId);
      perQuery.delete(args.queryId);
      if (seen === undefined) return Promise.resolve(args.result);
      const rows = args.result.rows.map((row) => {
        const stored = row[COLUMN];
        const raw = typeof stored === 'string' ? seen.get(stored) : undefined;
        return raw === undefined ? row : { ...row, [COLUMN]: raw };
      });
      return Promise.resolve({ ...args.result, rows });
    },
  };
};
