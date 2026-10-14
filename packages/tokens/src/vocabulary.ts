/**
 * Does the interface speak only the token vocabulary?
 *
 * Lint (`purlay/no-raw-visual-value`) refuses what can be seen in the syntax: a
 * hex colour, `w-[13px]`, a pixel in a `style`. It cannot see the rest, because
 * the rest is decided by Tailwind: `z-50`, `duration-300` and `border-2` are
 * ordinary-looking classes that Tailwind builds from a bare number whether or not
 * the theme has an opinion (`docs/spikes/design-tokens.md` measured exactly this),
 * and a typo like `bg-surfac-100` is an ordinary-looking class that builds to
 * nothing.
 *
 * So this asks Tailwind itself. It takes every class the application writes down,
 * compiles it against the real entry stylesheet, and fails when
 *
 * - **a class builds to nothing** — it is not in the vocabulary, or it is a typo,
 *   and either way it would silently do nothing in the browser; or
 * - **a class builds to a raw value** — a colour, a length, a duration or an
 *   unnamed number: the vocabulary was bypassed rather than extended.
 *
 * Where the classes are found is the other half of the design. Tailwind's own
 * scanner takes every word in every file, which makes the prose in a comment
 * ("border", "shadow") a class; that is right for building CSS and wrong for
 * judging code. Here a class is a string in a place that is *for* classes — a JSX
 * `className`, or an argument to `cn`/`clsx`/`cva` — found with the TypeScript
 * parser, so a finding names a file and a line.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';
import ts from 'typescript';

/** Variables whose strings are class lists: `iconClasses`, `buttonClasses`. */
const CLASS_LISTS = /(?:Classes|ClassNames)$/;

/** Calls whose string arguments are class lists. */
const CLASS_HELPERS = new Set(['cn', 'clsx', 'cva', 'tv']);

export interface ClassUse {
  readonly file: string;
  readonly line: number;
  readonly candidate: string;
  /** A class list assembled at runtime: neither Tailwind nor this check can know what it spells. */
  readonly dynamic?: true;
}

/** Classes that mark an element for a variant (`group-hover:`) and generate no CSS of their own. */
const MARKERS = /^(?:group|peer)(?:\/[\w-]+)?$/;

const isClassHelperCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  CLASS_HELPERS.has(node.expression.text);

/**
 * Every string reachable from `node` that could be part of a class list, and every
 * template literal with a hole in it (which cannot be judged).
 */
const stringsIn = (node: ts.Node, found: ts.LiteralLikeNode[], dynamic: ts.Node[]): void => {
  if (ts.isStringLiteralLike(node)) found.push(node);
  else if (ts.isTemplateExpression(node)) dynamic.push(node);
  // A condition chooses classes and is not one: \`status === 'failed' ? 'a' : 'b'\` writes a or b.
  else if (ts.isConditionalExpression(node)) {
    stringsIn(node.whenTrue, found, dynamic);
    stringsIn(node.whenFalse, found, dynamic);
    return;
  } else if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) return;
  // A function that is not a class helper is handed a name (\`buttonStyle('primary')\`), not
  // classes; its classes are judged where it writes them (a \`…Classes\` table).
  else if (ts.isCallExpression(node) && !isClassHelperCall(node)) return;
  node.forEachChild((child) => {
    stringsIn(child, found, dynamic);
  });
};

/**
 * The names a class position reads directly, or through a lookup (`sizes[size]`) or a choice. A
 * property's name (`a.b`'s `b`) is not one, and neither is anything inside a call that is not a class
 * helper, whose argument is a name, not classes.
 */
const namesIn = (node: ts.Node, names: Set<string>): void => {
  if (ts.isIdentifier(node)) {
    names.add(node.text);
    return;
  }
  if (ts.isPropertyAccessExpression(node)) {
    namesIn(node.expression, names);
    return;
  }
  if (ts.isCallExpression(node) && !isClassHelperCall(node)) return;
  node.forEachChild((child) => {
    namesIn(child, names);
  });
};

const COMPARISONS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** The classes a source file writes down, with where. Tests and type-only files have none worth judging. */
export const classesIn = (file: string, source: string): readonly ClassUse[] => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const uses: ClassUse[] = [];
  // The names a class position reads (`className={link}`, `cn(cell, …)`): whatever they hold is a
  // class list too, whatever it is called (#572).
  const named = new Set<string>();
  const take = (root: ts.Node): void => {
    const literals: ts.LiteralLikeNode[] = [];
    const dynamic: ts.Node[] = [];
    stringsIn(root, literals, dynamic);
    namesIn(root, named);
    for (const hole of dynamic) {
      const { line } = tree.getLineAndCharacterOfPosition(hole.getStart(tree));
      uses.push({ file, line: line + 1, candidate: hole.getText(tree), dynamic: true });
    }
    for (const literal of literals) {
      const { line } = tree.getLineAndCharacterOfPosition(literal.getStart(tree));
      for (const candidate of literal.text.split(/\s+/)) {
        if (candidate !== '') uses.push({ file, line: line + 1, candidate });
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'className') {
      // Taken whole: visiting inside it too would find a helper's classes a second time.
      if (node.initializer !== undefined) take(node.initializer);
      return;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      CLASS_LISTS.test(node.name.text) &&
      node.initializer !== undefined
    ) {
      // A table of class lists (`iconClasses = { sm: 'size-icon-sm …' }`) is where a
      // variant component keeps its classes. The name is the contract: anything
      // called `…Classes` is read as classes, so a typo in it is found like any other.
      take(node.initializer);
    } else if (isClassHelperCall(node)) {
      node.arguments.forEach(take);
      return;
    }
    node.forEachChild(visit);
  };
  visit(tree);
  // Then every constant one of those names holds, unless its name already had it read.
  const constants = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      named.has(node.name.text) &&
      !CLASS_LISTS.test(node.name.text) &&
      node.initializer !== undefined
    ) {
      take(node.initializer);
    }
    node.forEachChild(constants);
  };
  constants(tree);
  return uses;
};

// ---- what counts as a raw value, in Tailwind's output ------------------------------

const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color|color-mix)\(/i;
const LENGTH = /(?<![\w.-])-?\d*\.?\d+(?:px|rem|em|ch|ex|pt|cm|mm|in|pc|ms|s|deg|turn|rad)\b/;
const BEZIER = /cubic-bezier\(|steps\(/;
/** Properties whose unitless number is a visual decision. */
const NUMERIC_PROPERTIES = new Set(['z-index', 'opacity', 'font-weight', 'line-height']);
/** The one raw colour Tailwind uses for "no shadow here": fully transparent black. */
const ALLOWED = /#0000\b/g;

const isVar = (value: string): boolean => /^var\(--[\w-]+(?:,.*)?\)$/.test(value);

/** Declarations inside the `utilities` layer, which is where classes land. */
const utilityDeclarations = (css: string): readonly (readonly [string, string])[] => {
  const found: (readonly [string, string])[] = [];
  // `@layer utilities;` with no body is what a build with no match leaves behind.
  for (const start of css.matchAll(/@layer utilities\s*\{/g)) {
    const open = start.index + start[0].length - 1;
    let depth = 0;
    let end = open;
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1;
      if (css[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    for (const match of css.slice(open + 1, end).matchAll(/^\s*([a-z-]+)\s*:\s*([^;{}]+);/gm)) {
      found.push([match[1] ?? '', (match[2] ?? '').trim()]);
    }
  }
  return found;
};

export const rawValueIn = (property: string, value: string): string | undefined => {
  if (property.startsWith('--')) return undefined;
  if (isVar(value)) return undefined;
  const scrubbed = value.replace(ALLOWED, '');
  if (COLOUR.test(scrubbed)) return `a colour (${value})`;
  if (LENGTH.test(scrubbed)) return `a size or duration (${value})`;
  if (BEZIER.test(scrubbed)) return `an easing curve (${value})`;
  // Tailwind writes `opacity-50` as `50%`; the number is the same unnamed decision.
  const amount = /^(-?\d*\.?\d+)(%?)$/.exec(value);
  if (NUMERIC_PROPERTIES.has(property) && amount !== null) {
    const n = Number(amount[1]) / (amount[2] === '%' ? 100 : 1);
    if (property === 'opacity' && (n === 0 || n === 1)) return undefined;
    if (property === 'z-index' && n === 0) return undefined;
    return `an unnamed ${property} (${value})`;
  }
  return undefined;
};

/**
 * `@import` ids → files, resolved the way Node resolves a package: the
 * bundler's answer, without running the bundler.
 */
export const resolveStylesheet = (id: string): string => fileURLToPath(import.meta.resolve(id));

export interface VocabularyInput {
  /** The stylesheet the application imports: the real one, so the real vocabulary is judged. */
  readonly entry: string;
  /** Resolves `@import` ids to files, the way the bundler would. */
  readonly resolve: (id: string) => string;
  readonly classes: readonly ClassUse[];
}

export const checkVocabulary = async (input: VocabularyInput): Promise<readonly string[]> => {
  // The stylesheets are read once; each candidate gets a compiler of its own. Tailwind's `build` is
  // incremental — it answers with every utility built so far — so on one shared compiler a single raw
  // class was reported again against every class judged after it (#385).
  const sheets = new Map<string, string>();
  const read = (path: string): string => {
    const known = sheets.get(path);
    if (known !== undefined) return known;
    const content = readFileSync(path, 'utf8');
    sheets.set(path, content);
    return content;
  };
  const freshCompiler = async (): ReturnType<typeof compile> =>
    await compile(read(input.entry), {
      base: input.entry.slice(0, input.entry.lastIndexOf('/')),
      loadStylesheet: (id) => {
        const path = input.resolve(id);
        return Promise.resolve({
          path,
          base: path.slice(0, path.lastIndexOf('/')),
          content: read(path),
        });
      },
    });
  const problems: string[] = [];
  const judged = new Map<string, string | undefined>();
  const judge = async (candidate: string): Promise<string | undefined> => {
    const css = (await freshCompiler()).build([candidate]);
    const declarations = utilityDeclarations(css);
    if (declarations.length === 0)
      return 'builds to nothing: not in the token vocabulary, or a typo';
    for (const [property, value] of declarations) {
      const raw = rawValueIn(property, value);
      if (raw !== undefined) return `builds to ${raw} instead of a token`;
    }
    return undefined;
  };
  for (const use of input.classes) {
    if (use.dynamic === true) {
      problems.push(
        `${use.file}:${String(use.line)}  ${use.candidate}  is assembled at runtime: write each whole class so it can be checked (and so Tailwind can build it)`,
      );
      continue;
    }
    if (MARKERS.test(use.candidate)) continue;
    if (!judged.has(use.candidate)) judged.set(use.candidate, await judge(use.candidate));
    const verdict = judged.get(use.candidate);
    if (verdict !== undefined)
      problems.push(`${use.file}:${String(use.line)}  ${use.candidate}  ${verdict}`);
  }
  return problems;
};
