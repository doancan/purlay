/**
 * A unified diff as pasted (`git diff`, `diff -u`) read into what the diff viewer draws (#80,
 * D-133): files, their hunks, and each line as context, added or removed, with the line numbers it
 * has on each side.
 *
 * Pure, and forgiving the way a paste needs: lines before the first hunk header that are not a file
 * header are kept as notes; a block of `+`/`-` lines with no header at all is one hunk with no
 * numbers; a line it cannot place is kept as context rather than dropped — nothing pasted is lost.
 */

type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** The text without its `+`, `-` or space. */
  readonly text: string;
  /** Its number on the old side; null for an added line, or a hunk with no header. */
  readonly oldNumber: number | null;
  /** Its number on the new side; null for a removed line, or a hunk with no header. */
  readonly newNumber: number | null;
}

interface DiffHunk {
  /** The `@@ … @@` line as written, with what follows it; null for a hunk with no header. */
  readonly header: string | null;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  /** The paths it names, from `--- a/x` and `+++ b/x`; null where the paste had none. */
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly hunks: readonly DiffHunk[];
}

export interface ParsedDiff {
  readonly files: readonly DiffFile[];
  readonly added: number;
  readonly removed: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** `a/src/x.ts` is `src/x.ts`; `/dev/null` is no file. */
const pathOf = (line: string): string | null => {
  const raw = line.slice(4).split('\t')[0]?.trim() ?? '';
  if (raw === '/dev/null' || raw === '') return null;
  return /^[ab]\//.test(raw) ? raw.slice(2) : raw;
};

interface Building {
  oldPath: string | null;
  newPath: string | null;
  hunks: { header: string | null; lines: DiffLine[] }[];
}

interface State {
  readonly files: Building[];
  file: Building | null;
  hunk: Building['hunks'][number] | null;
  oldAt: number | null;
  newAt: number | null;
  added: number;
  removed: number;
}

const startFile = (state: State): Building => {
  const next: Building = { oldPath: null, newPath: null, hunks: [] };
  state.files.push(next);
  state.file = next;
  state.hunk = null;
  return next;
};

const currentHunk = (state: State): Building['hunks'][number] => {
  const into = state.file ?? startFile(state);
  if (state.hunk !== null) return state.hunk;
  const fresh = { header: null, lines: [] };
  into.hunks.push(fresh);
  state.hunk = fresh;
  return fresh;
};

/** Git's own notes between headers — `index …`, modes, renames — say nothing a reader needs. */
const NOTE =
  /^(index |new file mode|deleted file mode|old mode|new mode|similarity|rename |Binary )/;

const readLine = (state: State, line: string): void => {
  if (line.startsWith('diff --git ')) {
    startFile(state);
    return;
  }
  if (line.startsWith('--- ') && state.hunk === null) {
    const into =
      state.file !== null && state.file.hunks.length === 0 ? state.file : startFile(state);
    into.oldPath = pathOf(line);
    return;
  }
  if (line.startsWith('+++ ') && state.file !== null && state.file.hunks.length === 0) {
    state.file.newPath = pathOf(line);
    return;
  }
  const header = HUNK.exec(line);
  if (header !== null) {
    const into = state.file ?? startFile(state);
    state.hunk = { header: line, lines: [] };
    into.hunks.push(state.hunk);
    state.oldAt = Number(header[1]);
    state.newAt = Number(header[2]);
    return;
  }
  if ((state.hunk === null && NOTE.test(line)) || line === '\\ No newline at end of file') return;
  const into = currentHunk(state);
  const mark = line[0];
  const { oldAt, newAt } = state;
  if (mark === '+') {
    into.lines.push({ kind: 'added', text: line.slice(1), oldNumber: null, newNumber: newAt });
    state.added += 1;
    state.newAt = newAt === null ? null : newAt + 1;
  } else if (mark === '-') {
    into.lines.push({ kind: 'removed', text: line.slice(1), oldNumber: oldAt, newNumber: null });
    state.removed += 1;
    state.oldAt = oldAt === null ? null : oldAt + 1;
  } else {
    const text = mark === ' ' ? line.slice(1) : line;
    into.lines.push({ kind: 'context', text, oldNumber: oldAt, newNumber: newAt });
    state.oldAt = oldAt === null ? null : oldAt + 1;
    state.newAt = newAt === null ? null : newAt + 1;
  }
};

export const parseDiff = (text: string): ParsedDiff => {
  const state: State = {
    files: [],
    file: null,
    hunk: null,
    oldAt: null,
    newAt: null,
    added: 0,
    removed: 0,
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) readLine(state, line);
  // A trailing newline in the paste is not a line of the diff.
  for (const file of state.files) {
    const last = file.hunks.at(-1);
    const tail = last?.lines.at(-1);
    if (last !== undefined && tail?.kind === 'context' && tail.text === '') last.lines.pop();
  }
  // A hunk left with no lines, and a file left with no hunks, held nothing that was pasted.
  const files = state.files
    .map((file) => ({ ...file, hunks: file.hunks.filter((hunk) => hunk.lines.length > 0) }))
    .filter((file) => file.hunks.length > 0 || file.oldPath !== null || file.newPath !== null);
  return { files, added: state.added, removed: state.removed };
};

/** A row of the split view: the old side and the new side, either empty where there is nothing. */
export interface SplitRow {
  readonly old: DiffLine | null;
  readonly new: DiffLine | null;
}

/**
 * A hunk's lines side by side: context on both, each run of removals paired with the additions
 * that follow it, line for line, the longer run's rest against nothing.
 */
export const splitRows = (lines: readonly DiffLine[]): SplitRow[] => {
  const rows: SplitRow[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    if (line === undefined) break;
    if (line.kind === 'context') {
      rows.push({ old: line, new: line });
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
      rows.push({ old: removedRun[row] ?? null, new: addedRun[row] ?? null });
    }
  }
  return rows;
};
