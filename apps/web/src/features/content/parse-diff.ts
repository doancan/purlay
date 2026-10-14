/**
 * A unified diff as pasted (`git diff`, `diff -u`, `svn diff`) read into what the diff viewer draws
 * (#80, D-133): files, their hunks, and each line as context, added, removed or a note, with the
 * line numbers it has on each side.
 *
 * **Nothing pasted is lost.** Every line that is not a file header is a row: what git says about a
 * file (a rename, a copy, a binary file, a mode) and `\ No newline at end of file` are notes; so is
 * prose before, between or after the hunks.
 *
 * **A hunk ends where its header says.** `@@ -a,b +c,d @@` counts its lines, so a removed
 * `-- comment` inside a hunk is a removed line, and the next file's `---`/`+++` after it is a header.
 * Outside a hunk, `---` and `+++` are headers only as a pair — after `diff --git`, or followed by a
 * hunk — so a paste of `+`/`-` lines with no headers at all keeps every line, with no numbers.
 */

type DiffLineKind = 'context' | 'added' | 'removed' | 'note';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** The text without its `+`, `-` or space; a note's whole line. */
  readonly text: string;
  /** Its number on the old side; null for an added line, a note, or a hunk with no header. */
  readonly oldNumber: number | null;
  /** Its number on the new side; null for a removed line, a note, or a hunk with no header. */
  readonly newNumber: number | null;
}

interface DiffHunk {
  /** The `@@ … @@` line as written, with what follows it; null for lines under no header. */
  readonly header: string | null;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  /** The paths it names; null where the paste had none, or `/dev/null`. */
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly hunks: readonly DiffHunk[];
}

export interface ParsedDiff {
  readonly files: readonly DiffFile[];
  readonly added: number;
  readonly removed: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT = /^diff --git a\/(.+) b\/(.+)$/;

/** `a/src/x.ts` is `src/x.ts`; `/dev/null` is no file. */
const pathOf = (line: string): string | null => {
  const raw = line.slice(4).split('\t')[0]?.trim() ?? '';
  if (raw === '/dev/null' || raw === '') return null;
  return /^[ab]\//.test(raw) ? raw.slice(2) : raw;
};

interface Building {
  /** Started by `diff --git`: its `---`/`+++` may follow git's notes rather than a hunk. */
  readonly git: boolean;
  oldPath: string | null;
  newPath: string | null;
  hunks: { header: string | null; lines: DiffLine[] }[];
}

interface State {
  readonly files: Building[];
  file: Building | null;
  hunk: Building['hunks'][number] | null;
  /** Lines the open hunk's header still promises on each side; zero when no hunk is open. */
  oldLeft: number;
  newLeft: number;
  oldAt: number | null;
  newAt: number | null;
  /** A paste with no headers at all: its `+`/`-` lines are one hunk with no numbers. */
  bare: boolean;
  added: number;
  removed: number;
}

const startFile = (
  state: State,
  oldPath: string | null,
  newPath: string | null,
  git = false,
): Building => {
  const next: Building = { git, oldPath, newPath, hunks: [] };
  state.files.push(next);
  state.file = next;
  state.hunk = null;
  return next;
};

/** Lines that are no hunk's: a note row in the file's own hunk with no header. */
const loose = (state: State): Building['hunks'][number] => {
  const into = state.file ?? startFile(state, null, null);
  const last = into.hunks.at(-1);
  if (last?.header === null) return last;
  const fresh = { header: null, lines: [] };
  into.hunks.push(fresh);
  return fresh;
};

const note = (state: State, text: string): void => {
  (state.hunk ?? loose(state)).lines.push({
    kind: 'note',
    text,
    oldNumber: null,
    newNumber: null,
  });
};

/** A `+`, `-` or ` ` line inside an open hunk, or under no header at all. */
const change = (state: State, line: string): void => {
  const into = state.hunk ?? loose(state);
  const mark = line[0];
  const text = line.slice(1);
  if (mark === '+') {
    into.lines.push({ kind: 'added', text, oldNumber: null, newNumber: state.newAt });
    state.added += 1;
    state.newLeft -= 1;
    state.newAt = state.newAt === null ? null : state.newAt + 1;
  } else if (mark === '-') {
    into.lines.push({ kind: 'removed', text, oldNumber: state.oldAt, newNumber: null });
    state.removed += 1;
    state.oldLeft -= 1;
    state.oldAt = state.oldAt === null ? null : state.oldAt + 1;
  } else {
    into.lines.push({
      kind: 'context',
      text: mark === ' ' ? text : line,
      oldNumber: state.oldAt,
      newNumber: state.newAt,
    });
    state.oldLeft -= 1;
    state.newLeft -= 1;
    state.oldAt = state.oldAt === null ? null : state.oldAt + 1;
    state.newAt = state.newAt === null ? null : state.newAt + 1;
  }
};

const open = (state: State): boolean => state.oldLeft > 0 || state.newLeft > 0;

/** Whether `---` at `at` starts a header pair: `+++` next, and a hunk or nothing after it. */
const headerPair = (lines: readonly string[], at: number): boolean =>
  (lines[at] ?? '').startsWith('--- ') &&
  (lines[at + 1] ?? '').startsWith('+++ ') &&
  ((lines[at + 2] ?? '').startsWith('@@ ') || at + 2 >= lines.length);

export const parseDiff = (text: string): ParsedDiff => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // Only the paste's own last line break, if it ends with one: a blank context line is a line.
  if (lines.at(-1) === '') lines.pop();
  const state: State = {
    files: [],
    file: null,
    hunk: null,
    oldLeft: 0,
    newLeft: 0,
    oldAt: null,
    newAt: null,
    bare: !lines.some((line) => HUNK.test(line) || GIT.test(line)),
    added: 0,
    removed: 0,
  };
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? '';
    if (line.startsWith('\\')) {
      // `\ No newline at end of file`: about the line before it, inside the hunk or just after.
      note(state, line);
      continue;
    }
    if (open(state)) {
      if (/^[ +-]/.test(line) || line === '') {
        change(state, line);
        continue;
      }
      // Shorter than its header said: the hunk ends here, and this line is read as outside one.
      state.oldLeft = 0;
      state.newLeft = 0;
    }
    const git = GIT.exec(line);
    if (git !== null) {
      startFile(state, git[1] ?? null, git[2] ?? null, true);
      continue;
    }
    // After `diff --git` and its notes, before any hunk: this file's own `---`/`+++`.
    const fromGit =
      state.file?.git === true && state.file.hunks.every((hunk) => hunk.header === null);
    if (line.startsWith('--- ') && (headerPair(lines, at) || fromGit)) {
      const paths = { old: pathOf(line), new: pathOf(lines[at + 1] ?? '') };
      if (fromGit && state.file !== null) {
        state.file.oldPath = paths.old ?? (paths.new === null ? state.file.oldPath : null);
        state.file.newPath = paths.new ?? (paths.old === null ? state.file.newPath : null);
      } else {
        startFile(state, paths.old, paths.new);
      }
      if ((lines[at + 1] ?? '').startsWith('+++ ')) at += 1;
      continue;
    }
    const header = HUNK.exec(line);
    if (header !== null) {
      const into = state.file ?? startFile(state, null, null);
      state.hunk = { header: line, lines: [] };
      into.hunks.push(state.hunk);
      state.oldAt = Number(header[1]);
      state.newAt = Number(header[3]);
      state.oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      state.newLeft = header[4] === undefined ? 1 : Number(header[4]);
      continue;
    }
    if (state.bare && /^[ +-]/.test(line)) {
      change(state, line);
      continue;
    }
    // Anything else — git's notes, a rename, a binary file, prose — is kept, as a note.
    state.hunk = null;
    note(state, line);
  }
  return {
    files: state.files.map(({ oldPath, newPath, hunks }) => ({ oldPath, newPath, hunks })),
    added: state.added,
    removed: state.removed,
  };
};

/**
 * A row of the split view: the old side and the new side, either empty where there is nothing; or
 * a note, which is about the lines rather than one side, across both.
 */
export type SplitRow =
  | { readonly kind: 'pair'; readonly old: DiffLine | null; readonly new: DiffLine | null }
  | { readonly kind: 'note'; readonly line: DiffLine };

/**
 * A hunk's lines side by side: context on both, notes across both, each run of removals paired
 * with the additions that follow it, line for line, the longer run's rest against nothing.
 */
export const splitRows = (lines: readonly DiffLine[]): SplitRow[] => {
  const rows: SplitRow[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    if (line === undefined) break;
    if (line.kind === 'note') {
      rows.push({ kind: 'note', line });
      at += 1;
      continue;
    }
    if (line.kind === 'context') {
      rows.push({ kind: 'pair', old: line, new: line });
      at += 1;
      continue;
    }
    const removedRun: DiffLine[] = [];
    for (let next = lines[at]; next?.kind === 'removed'; next = lines[at]) {
      removedRun.push(next);
      at += 1;
    }
    const addedRun: DiffLine[] = [];
    for (let next = lines[at]; next?.kind === 'added'; next = lines[at]) {
      addedRun.push(next);
      at += 1;
    }
    const length = Math.max(removedRun.length, addedRun.length);
    for (let row = 0; row < length; row++) {
      rows.push({ kind: 'pair', old: removedRun[row] ?? null, new: addedRun[row] ?? null });
    }
  }
  return rows;
};
