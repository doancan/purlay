/** Run the same ESLint configuration in serial processes so project-service heaps are released. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Root files and directories remain covered; workspace containers use one child per entry. */
export const lintGroups = (
  root: string,
  workspaces: readonly string[],
): readonly (readonly string[])[] => {
  const containers = new Set(workspaces.map((pattern) => pattern.split('/')[0]));
  const groups: string[][] = [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) {
      if (containers.has(entry.name)) {
        for (const child of readdirSync(join(root, entry.name)).sort())
          groups.push([join(entry.name, child)]);
      } else groups.push([entry.name]);
    } else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(entry.name);
  }
  if (files.length > 0) groups.push(files);
  return groups;
};

/** A child is the external seam: any failed or killed lint process refuses the command. */
export const runLint = (
  groups: readonly (readonly string[])[],
  flags: readonly string[],
  run: (args: readonly string[]) => number,
): number => {
  for (const group of groups) {
    const code = run(['--no-error-on-unmatched-pattern', '--no-warn-ignored', ...flags, ...group]);
    if (code !== 0) return code;
  }
  return 0;
};

/** The CLI policy stays testable without fixing or reading the developer's own source tree. */
export const lintMain = (
  root: string,
  workspaces: readonly string[],
  flags: readonly string[],
): number => {
  if (flags.some((flag) => flag !== '--fix')) {
    console.error('lint supports only --fix; invoke ESLint directly for custom reporting options.');
    return 2;
  }
  return runLint(lintGroups(root, workspaces), flags, (args) => {
    console.log('Linting ' + args.join(' '));
    return Bun.spawnSync([join(root, 'node_modules/.bin/eslint'), ...args], {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    }).exitCode;
  });
};
