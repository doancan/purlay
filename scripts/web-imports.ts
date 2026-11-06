/**
 * What the web client's files import, read with the compiler's parser and not with a regular expression, so a path in a
 * comment or a string is not an import. The fence (`web-fences.test.ts`) and the budget (`budget-web.ts`) both ask it;
 * ESLint cannot, because a rule sees one file and the specifier as it was written, not the file it names.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export interface WebImport {
  /** The importing file, relative to the source folder, with forward slashes. */
  readonly from: string;
  /** The file the specifier names, in the same form. */
  readonly to: string;
  /** `import()`: a chunk of its own, not part of the importer's. */
  readonly lazy: boolean;
  /** Erased by the build: `import type`, or a list of names that are all `type`. */
  readonly typeOnly: boolean;
}

const SOURCE = /\.tsx?$/;
const TEST = /\.test\.tsx?$/;
const CANDIDATES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** A test, or the harness tests are built with: not part of the build, so held to less than the client. */
export const isTestSource = (path: string): boolean =>
  TEST.test(path) || path.startsWith('testing/');

const sourcesUnder = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return SOURCE.test(name) ? [path] : [];
  });

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

const resolved = (from: string, specifier: string): string | null => {
  const base = resolve(dirname(from), specifier);
  for (const suffix of CANDIDATES) if (isFile(base + suffix)) return base + suffix;
  return null;
};

const allTypeNames = (clause: ts.ImportClause | undefined): boolean => {
  if (clause === undefined) return false;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
};

interface Specifier {
  readonly text: string;
  readonly lazy: boolean;
  readonly typeOnly: boolean;
}

const specifiersOf = (file: string): Specifier[] => {
  const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: Specifier[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const typeOnly = ts.isImportDeclaration(node)
        ? allTypeNames(node.importClause)
        : node.isTypeOnly;
      found.push({ text: node.moduleSpecifier.text, lazy: false, typeOnly });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push({ text: node.arguments[0].text, lazy: true, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
};

/** Every relative import in the source folder that names a file in it, paths relative to the folder. */
export const webImports = (source: string): WebImport[] =>
  sourcesUnder(source).flatMap((file) =>
    specifiersOf(file).flatMap(({ text, lazy, typeOnly }) => {
      if (!text.startsWith('.')) return [];
      const target = resolved(file, text);
      if (target === null) return [];
      return [
        {
          from: relative(source, file).replaceAll('\\', '/'),
          to: relative(source, target).replaceAll('\\', '/'),
          lazy,
          typeOnly,
        },
      ];
    }),
  );

/** The files a build puts in one chunk with `roots`: what they import statically, and what that does, and so on. */
export const staticClosure = (
  imports: readonly WebImport[],
  roots: readonly string[],
): Set<string> => {
  const next = new Map<string, string[]>();
  for (const found of imports) {
    if (found.lazy || found.typeOnly) continue;
    next.set(found.from, [...(next.get(found.from) ?? []), found.to]);
  }
  const seen = new Set(roots);
  const pending = [...roots];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    for (const target of next.get(file) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      pending.push(target);
    }
  }
  return seen;
};

/** The module a file belongs to: the id of the `features/<id>/` folder it is in, when that folder is a module. */
export const moduleOfFile = (path: string, ids: readonly string[]): string | undefined => {
  const [features, folder] = path.split('/');
  return features === 'features' && folder !== undefined && ids.includes(folder)
    ? folder
    : undefined;
};

/** The registry is the one core file that names a module, and it names the manifest. */
const REGISTRY = 'modules/registry.ts';

export interface AllowedImport {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

/**
 * What is wrong with who imports whom, one sentence each (D-277): a module importing another, the core importing a
 * module's file that is neither the registry's manifest nor on the list, and a list entry that is not an import any
 * more, is listed twice or gives no reason. Tests, and the harness they are built with, may import a module: they
 * compose the whole client, and none of them ships.
 */
export const fenceProblems = (
  imports: readonly WebImport[],
  ids: readonly string[],
  allowed: readonly AllowedImport[],
): string[] => {
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const { from, to, reason } of allowed) {
    const key = `${from} -> ${to}`;
    if (listed.has(key)) problems.push(`${key} is listed twice`);
    listed.add(key);
    if (reason.trim() === '') problems.push(`${key} is listed with no reason`);
  }
  const seen = new Set<string>();
  for (const { from, to } of imports) {
    const importer = moduleOfFile(from, ids);
    const imported = moduleOfFile(to, ids);
    if (imported === undefined || importer === imported) continue;
    if (importer !== undefined) {
      problems.push(`the ${importer} module imports the ${imported} module: ${from} -> ${to}`);
      continue;
    }
    if (isTestSource(from)) continue;
    if (from === REGISTRY && to === `features/${imported}/manifest.ts`) continue;
    seen.add(`${from} -> ${to}`);
    if (!listed.has(`${from} -> ${to}`)) {
      problems.push(
        `${from} imports ${to}; the core reaches a module through modules/registry, or the file is listed in CORE_IMPORTS_OF_MODULES with its reason`,
      );
    }
  }
  for (const key of listed) {
    if (!seen.has(key)) {
      problems.push(
        `${key} is listed in CORE_IMPORTS_OF_MODULES and is no longer an import; delete the entry`,
      );
    }
  }
  return problems;
};
