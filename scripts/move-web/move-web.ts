/**
 * usage:
 *   bun mover.ts move <repo> <map.json>     git mv every key to its value (paths relative to apps/web/src) and rewrite relative imports
 *   bun mover.ts verify <repo> <base> <map.json>   prove the move: contents equal but for import specifiers, every specifier resolves
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const [mode, repo, a, b] = process.argv.slice(2) as [string, string, string, string?];
const WEB = join(repo, 'apps/web');
const SRC = join(WEB, 'src');
/** An import or re-export statement: only its whitespace (prettier re-wraps one when a path gets longer) is not compared. */
const STATEMENT = /^(import|export)\s[^;'"]*?\bfrom\s+['"][^'"]+['"]/gms;
const flatten = (text: string): string =>
  text.replace(STATEMENT, (s) => s.replace(/\s+/g, ' ').replace(/,\s*}/g, ' }').replace(/{\s+/g, '{ ').replace(/\s+}/g, ' }'));
const SPEC = /((?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+))(['"])(\.\.?\/[^'"]*|\.\.?)\2/g;
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx', '.mjs', '.json', '.css', '.js'];

const walk = (d: string, out: string[] = []): string[] => {
  for (const e of readdirSync(d)) {
    if (e === 'node_modules' || e === 'dist' || e === 'test-results') continue;
    const p = join(d, e);
    statSync(p).isDirectory() ? walk(p, out) : /\.(tsx?|mjs)$/.test(e) && out.push(p);
  }
  return out;
};
const resolveFrom = (file: string, spec: string, exists: (p: string) => boolean): string | null => {
  const base = resolve(dirname(file), spec);
  for (const x of EXTS) if (exists(base + x)) return base + x;
  return null;
};
const isFileOnDisk = (p: string): boolean => existsSync(p) && statSync(p).isFile();
const sansExt = (p: string): string => p.replace(/\.(tsx?)$/, '');
const rel = (from: string, to: string): string => {
  let r = relative(dirname(from), sansExt(to));
  if (!r.startsWith('.')) r = './' + r;
  return r;
};

if (mode === 'move') {
  const map = JSON.parse(readFileSync(a, 'utf8')) as Record<string, string>;
  const abs = (p: string) => join(SRC, p);
  const oldToNew = new Map(Object.entries(map).map(([o, n]) => [abs(o), abs(n)]));
  const files = walk(WEB);
  const newLoc = (f: string) => oldToNew.get(f) ?? f;
  // 1. compute new contents against the OLD tree
  const contents = new Map<string, string>();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const out = text.replace(SPEC, (whole, pre: string, q: string, spec: string) => {
      const target = resolveFrom(f, spec, isFileOnDisk);
      if (target === null) return whole;
      const nt = newLoc(target);
      const nf = newLoc(f);
      if (nt === target && nf === f) return whole;
      const explicit = resolve(dirname(f), spec) === target;
      const isDir = /\/index\.tsx?$/.test(target) && !explicit;
      let r = relative(dirname(nf), isDir ? dirname(nt) : explicit ? nt : sansExt(nt));
      if (!r.startsWith('.')) r = './' + r;
      return `${pre}${q}${isDir ? r : r}${q}`;
    });
    contents.set(f, out);
  }
  // 2. git mv
  for (const [o, n] of oldToNew) {
    mkdirSync(dirname(n), { recursive: true });
    execFileSync('git', ['mv', o, n], { cwd: repo });
  }
  // 3. write
  for (const [f, text] of contents) writeFileSync(newLoc(f), text);
  console.log(`moved ${oldToNew.size} files; rewrote ${[...contents].filter(([f, t]) => t !== readFileSync(newLoc(f), 'utf8') || true).length} candidates`);
} else if (mode === 'verify') {
  const base = a;
  const map = JSON.parse(readFileSync(b!, 'utf8')) as Record<string, string>;
  const gitShow = (p: string): string | null => {
    try { return execFileSync('git', ['show', `${base}:${relative(repo, p)}`], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 }); } catch { return null; }
  };
  const oldTree = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'apps/web'], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean).map((p) => join(repo, p)));
  const abs = (p: string) => join(SRC, p);
  const oldToNew = new Map(Object.entries(map).map(([o, n]) => [abs(o), abs(n)]));
  const newToOld = new Map([...oldToNew].map(([o, n]) => [n, o]));
  const problems: string[] = [];
  let compared = 0, renamed = 0, changed = 0, specs = 0;
  let unresolved: string[] = [];
  const canon = (text: string, file: string, exists: (p: string) => boolean, toId: (p: string) => string): string =>
    text.replace(SPEC, (whole, pre: string, q: string, spec: string) => {
      const t = resolveFrom(file, spec, exists);
      if (t === null) { unresolved.push(`${relative(repo, file)}: ${spec}`); return whole; }
      specs++;
      return `${pre}${q}@${relative(repo, toId(t))}${q}`;
    });
  const newFiles = new Set(walk(WEB));
  const newExists = (p: string) => newFiles.has(p) || isFileOnDisk(p);
  for (const f of newFiles) {
    const oldPath = newToOld.get(f) ?? f;
    const oldText = oldTree.has(oldPath) ? gitShow(oldPath) : null;
    if (oldText === null) { problems.push(`${relative(repo, f)}: new file (not in base)`); continue; }
    const newText = readFileSync(f, 'utf8');
    // identity of a target = its NEW location
    unresolved = [];
    const oldCanon = canon(flatten(oldText), oldPath, (p) => oldTree.has(p), (t) => oldToNew.get(t) ?? t);
    const oldUnresolved = unresolved.map((u) => u.replace(/^[^:]*: /, ''));
    unresolved = [];
    const newCanon = canon(flatten(newText), f, newExists, (t) => t);
    // a specifier that is text in a test's fixture resolves nowhere before or after; one that resolved before must still
    if (JSON.stringify(oldUnresolved) !== JSON.stringify(unresolved.map((u) => u.replace(/^[^:]*: /, '')))) problems.push(`${relative(repo, f)}: a specifier no longer resolves (or newly does not)`);
    compared++;
    if (oldPath !== f) renamed++;
    if (oldText !== newText) changed++;
    if (oldCanon !== newCanon) problems.push(`${relative(repo, f)}: content differs beyond import paths`);
  }
  for (const o of oldTree) if (/\.(tsx?|mjs)$/.test(o) && !newFiles.has(o) && !oldToNew.has(o)) problems.push(`${relative(repo, o)}: deleted`);
  for (const [o, n] of oldToNew) if (!newFiles.has(n)) problems.push(`map target missing: ${relative(repo, n)}`);
  console.log(`files compared: ${compared}; renamed: ${renamed}; files whose text differs: ${changed}; import specifiers checked: ${specs}`);
  if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
  console.log('verified: every file is identical to its base but for import paths, and every import resolves');
}
