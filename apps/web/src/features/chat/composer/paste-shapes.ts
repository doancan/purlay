/**
 * What a paste *is*, by its shape (D-259): pure answers, no DOM. `paste.ts` decides what each shape
 * becomes; this file only recognises them, and each recogniser errs towards "it is words" — a
 * conversion that is wrong costs the person a step, one that is missed costs nothing.
 *
 * - **A single line of code** is an inline span, and only when the whole line is the command, the path
 *   or the statement — never a sentence that has one in it.
 * - **A short block of code** is fenced in its language when the language is certain.
 * - **Markdown** is left as it is, so it is drawn as Markdown, not shown as a code block.
 * - **A very long text** is a file, not a message.
 * - **The clipboard's files** are the pictures and files the person copied, unless the clipboard's
 *   words are what was meant (a spreadsheet's range comes with a picture of itself).
 */
import { MESSAGE_CONTENT_MAX } from '@purlay/types';

/** From this many lines a paste is a file, not a message (D-259). */
const FILE_AFTER_LINES = 500;

/** At most this long a line is a command or a statement; a longer one is a paragraph. */
const SINGLE_LINE_MAX = 200;

const NODE_TASKS = [
  'install',
  'i',
  'add',
  'run',
  'test',
  'build',
  'start',
  'dev',
  'ci',
  'init',
  'update',
  'publish',
  'exec',
  'dlx',
  'x',
  'remove',
  'uninstall',
  'create',
  'upgrade',
  'audit',
  'link',
  'pack',
] as const;
const PACKAGES = [
  'install',
  'update',
  'upgrade',
  'remove',
  'search',
  'purge',
  'autoremove',
  'list',
  'show',
  'uninstall',
  'freeze',
] as const;

/**
 * Programs, and the words each takes first. A program's name is also a word of speech — `git` is "go" in
 * Turkish, `curl` and `brew` are English verbs — so a line is a command only with evidence: one of these
 * subcommands, a flag, or a path. A program with no list is judged by a flag or a path alone.
 */
const PROGRAMS: Readonly<Record<string, readonly string[]>> = {
  git: [
    'add',
    'commit',
    'push',
    'pull',
    'rebase',
    'checkout',
    'status',
    'diff',
    'log',
    'merge',
    'clone',
    'fetch',
    'stash',
    'reset',
    'branch',
    'switch',
    'tag',
    'cherry-pick',
    'restore',
    'init',
    'remote',
    'show',
    'bisect',
    'blame',
    'revert',
  ],
  npm: NODE_TASKS,
  pnpm: NODE_TASKS,
  yarn: NODE_TASKS,
  bun: NODE_TASKS,
  npx: [],
  bunx: [],
  docker: [
    'run',
    'ps',
    'build',
    'compose',
    'pull',
    'push',
    'exec',
    'logs',
    'stop',
    'start',
    'images',
    'rm',
    'rmi',
    'network',
    'volume',
    'system',
    'login',
    'tag',
    'inspect',
    'restart',
  ],
  'docker-compose': ['up', 'down', 'build', 'logs', 'ps', 'exec', 'run', 'restart', 'pull'],
  kubectl: [
    'get',
    'apply',
    'describe',
    'logs',
    'delete',
    'exec',
    'rollout',
    'port-forward',
    'config',
    'scale',
    'top',
    'create',
    'edit',
    'patch',
    'cp',
  ],
  helm: ['install', 'upgrade', 'list', 'repo', 'template', 'uninstall', 'rollback', 'lint'],
  brew: [
    'install',
    'update',
    'upgrade',
    'uninstall',
    'list',
    'search',
    'info',
    'services',
    'tap',
    'doctor',
    'cleanup',
  ],
  systemctl: [
    'start',
    'stop',
    'restart',
    'status',
    'enable',
    'disable',
    'reload',
    'daemon-reload',
    'is-active',
  ],
  apt: PACKAGES,
  'apt-get': PACKAGES,
  pip: PACKAGES,
  pip3: PACKAGES,
  cargo: [
    'build',
    'run',
    'test',
    'check',
    'add',
    'install',
    'publish',
    'fmt',
    'clippy',
    'new',
    'init',
  ],
  curl: [],
  wget: [],
  ssh: [],
  scp: [],
  psql: [],
  journalctl: [],
  chmod: [],
  chown: [],
  mkdir: [],
  tail: [],
  grep: [],
  sudo: [],
};

/** A flag, a path, a home directory, or `user@host`: what a sentence has no reason to carry. */
const COMMAND_EVIDENCE = /(^|\s)-{1,2}[A-Za-z0-9]|[/~@]/;

/** Whether these words are a command: a known program, with evidence that it is one. */
const isCommandWords = (words: readonly string[], text: string): boolean => {
  const [first = '', second = ''] = words;
  const subcommands = PROGRAMS[first];
  if (subcommands === undefined || words.length < 2) return false;
  // `sudo` runs another program: that one is judged.
  if (first === 'sudo') return isCommandWords(words.slice(1), text);
  return subcommands.includes(second) || COMMAND_EVIDENCE.test(text);
};

const SOURCE_EXTENSIONS = 'ts|tsx|js|jsx|mjs|json|md|py|go|rs|css|sql|yml|yaml|sh|toml|env|html';

/**
 * Whether one line is code as a whole — a shell command, a file path with its line, an assignment of
 * an environment variable, a statement — so it may be an inline span. A line with words round it
 * (`see src/x.ts:14 for it`) is a sentence and stays one.
 */
export const isSingleLineCode = (line: string): boolean => {
  const text = line.trim();
  if (text === '' || text.includes('\n') || text.includes('`') || text.length > SINGLE_LINE_MAX) {
    return false;
  }
  // A path, with its line and column when the compiler or a stack trace gave them.
  if (new RegExp(`^[\\w./@-]+\\.(${SOURCE_EXTENSIONS})(:\\d+){0,2}$`).test(text)) return true;
  // `FOO_BAR=baz`: an environment variable, nothing round it.
  if (/^[A-Z][A-Z0-9_]{2,}=\S+$/.test(text)) return true;
  // A prompt's `$ ` is part of a command only before a program or a path: `$ 50 for lunch` is an amount.
  const prompted = text.startsWith('$ ');
  const body = prompted ? text.slice(2) : text;
  if (prompted && /^(\.\/|~\/|\/)\S/.test(body)) return true;
  if (isCommandWords(body.split(/\s+/), body)) return true;
  if (prompted) return false;
  // A statement: the whole line, from its keyword to its end.
  return (
    /^(const|let|var) [\w$]+\s*(:[^=]+)?=\s*\S/.test(text) ||
    /^import .+ from ['"][^'"]+['"];?$/.test(text) ||
    /^(export )?(async )?function \w+\(.*\)\s*\{?$/.test(text) ||
    /^def \w+\(.*\):$/.test(text) ||
    /^[\w$]+(\.[\w$]+)+\([^()]*\);?$/.test(text) ||
    /^[A-Z ]*\b(SELECT .+ FROM|INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b.*;?$/.test(text)
  );
};

/** A stack trace's frames: the shape of a JavaScript, a Java or a Python trace. */
const isStackTrace = (text: string): boolean => {
  const lines = text.split('\n');
  const frames = lines.filter(
    (line) =>
      /^\s+at \S.*(\(.*:\d+(:\d+)?\)|:\d+(:\d+)?$)/.test(line) ||
      /^\s+File ".+", line \d+/.test(line),
  );
  return frames.length >= 2 || (frames.length >= 1 && /^\w*(Error|Exception)\b/.test(text));
};

/** A line that shows code is JavaScript or TypeScript and not a sentence with `return` in it. */
const CODE_LINE =
  /^\s*(const|let|var) [\w${[]+\s*=|^\s*import .+ from |^\s*export (default|const|function|class|type|interface) |[;{}]\s*$|=>/m;

/** A line of JavaScript or TypeScript that is code, not a sentence with `return` in it. */
const isScripted = (text: string): boolean => CODE_LINE.test(text);

/** What makes a language certain in a few lines, where `languageOf`'s own test would take a sentence for it. */
const CERTAIN: Readonly<Record<string, (text: string) => boolean>> = {
  js: isScripted,
  ts: isScripted,
  tsx: isScripted,
  // Upper case, as it is written in a statement: "Select one from the menu" is a request.
  sql: (text) =>
    /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE)\b/.test(text) &&
    /\b(FROM|WHERE|VALUES|SET|ON)\b/.test(text),
  // A file with its package clause and a declaration, or a function with `:=`; "package arrived" is a courier's.
  go: (text) =>
    (/^package \w+$/m.test(text) && /^(func|import|type|var|const)\b/m.test(text)) ||
    (/^func \w*\(/m.test(text) && text.includes(':=')),
  // A shebang, or a session in which every line is a prompt and a command: "$ 50 lunch" is a price.
  bash: (text) =>
    /^#!.*\b(ba|z)?sh\b/.test(text) ||
    text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .every((line) => line.startsWith('$ ') && isSingleLineCode(line)),
};

/**
 * The language of a short paste when it is certain, `''` for a block with no language (a stack
 * trace), `null` when it is words. YAML is never certain in a few lines: `Owner: Ali` / `Due: Friday`
 * is a chat message, and `languageOf` reads these few lines in words as SQL, Go and a shell too.
 */
export const shortBlockLanguage = (text: string, language: string | null): string | null => {
  if (isStackTrace(text)) return '';
  if (language === null || language === 'yaml') return null;
  return (CERTAIN[language]?.(text) ?? true) ? language : null;
};

/**
 * Whether the words are Markdown a person wrote — headings, lists, a table, a fence, emphasis, a
 * link — and not code with `#` comments: at least two kinds of it. Called only when the text is not
 * code in a language.
 */
export const looksLikeMarkdown = (text: string): boolean => {
  const signals = [
    /^#{1,6} \S/m,
    /^[ \t]*([-*+]|\d+\.) \S.*\n[ \t]*([-*+]|\d+\.) \S/m,
    /^```/m,
    /^\|.+\|[ \t]*\n\|[\s:|-]+\|/m,
    /\*\*[^*\n]+\*\*/,
    /\[[^[\]\n]+\]\(https?:[^)\s]+\)/,
    /^> \S/m,
  ];
  return signals.filter((signal) => signal.test(text)).length >= 2;
};

const GLYPH_ITEM = /^([ \t]*)([•●▪◦○‣∙■☐□⬜☑✔✓✅☒])[ \t]+(\S.*)$/;
const PAREN_ITEM = /^([ \t]*)(\d{1,3})\)[ \t]+(\S.*)$/;
const OPEN_BOXES = new Set(['☐', '□', '⬜']);
const DONE_BOXES = new Set(['☑', '✔', '✓', '✅', '☒']);

/**
 * A list copied as plain words — a PDF's, a note's, a mail's: `•` bullets, `☐` `☑` boxes, `1)` numbers —
 * as a Markdown list the renderer draws, or `null` when it is not one: at least two items, and at least
 * half the lines. A dash is a speaker in a dialogue and a number with `)` may be a sentence's, so neither
 * a dash nor a `1)` out of order is read (D-259). Lines that are not items are kept, with a blank line
 * between them and the list so they are not drawn as its continuation.
 */
export const listFromPlain = (text: string): string | null => {
  const lines = text.replace(/\n+$/, '').split('\n');
  const numbers = lines.flatMap((line) => {
    const found = PAREN_ITEM.exec(line);
    return found === null ? [] : [Number(found[2])];
  });
  // `1)` `2)` `3)`: numbers that count on, or a sentence's own `2)` is left alone.
  const counted =
    numbers.length >= 2 &&
    numbers.every((number, at) => at === 0 || number === (numbers[at - 1] ?? -2) + 1);
  const out: string[] = [];
  let items = 0;
  let previousItem = false;
  for (const line of lines) {
    const glyph = GLYPH_ITEM.exec(line);
    const paren = counted ? PAREN_ITEM.exec(line) : null;
    let item: string | null = null;
    if (glyph !== null) {
      const level = Math.floor((glyph[1] ?? '').replace(/\t/g, '  ').length / 2);
      const mark = glyph[2] ?? '';
      const box = OPEN_BOXES.has(mark) ? '[ ] ' : DONE_BOXES.has(mark) ? '[x] ' : '';
      item = `${'  '.repeat(level)}- ${box}${glyph[3] ?? ''}`;
    } else if (paren !== null) {
      item = `${paren[2] ?? ''}. ${paren[3] ?? ''}`;
    }
    if (item !== null) {
      if (!previousItem && out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(item);
      items += 1;
    } else {
      if (previousItem && line.trim() !== '' && !/^[ \t]/.test(line)) out.push('');
      out.push(line);
    }
    previousItem = item !== null;
  }
  const filled = lines.filter((line) => line.trim() !== '').length;
  return items >= 2 && items * 2 >= filled ? out.join('\n') : null;
};

/** A URL, alone: what a link is made of. */
const URL_ALONE = /^https?:\/\/[^\s<>[\]()]+$/i;

/**
 * `[selected](url)` when a URL is pasted over words on one line; `null` otherwise — over nothing, a
 * URL is a URL, and brackets in the selection would end the link early.
 */
export const linkOverSelection = (pasted: string, selected: string): string | null => {
  const url = pasted.trim();
  if (!URL_ALONE.test(url) || selected.trim() === '') return null;
  if (/[\n[\]]/.test(selected)) return null;
  return `[${selected}](${url})`;
};

/** How many lines a text has: a last line break ends a line, it does not start one. */
const linesOf = (text: string): number => text.replace(/\n+$/, '').split('\n').length;

/** A text's file, for a text too long to be a message. */
export interface TextFile {
  readonly name: string;
  readonly type: string;
  readonly text: string;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  json: 'json',
  sql: 'sql',
  go: 'go',
  rust: 'rs',
  python: 'py',
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  css: 'css',
  html: 'html',
  yaml: 'yaml',
  bash: 'sh',
  diff: 'diff',
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** `20261105-1432`: the minute a file was made, in the person's own clock. */
export const minuteStamp = (now: Date): string =>
  `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

/**
 * The paste as a file, or `null` when it is a message: from `FILE_AFTER_LINES` lines, or more than a
 * message may hold. A file named for the minute it was made, with the extension its content has —
 * `.md` for Markdown, its language's for code, `.txt` for words.
 */
export const textFileFor = (text: string, language: string | null, now: Date): TextFile | null => {
  if (linesOf(text) < FILE_AFTER_LINES && text.length <= MESSAGE_CONTENT_MAX) return null;
  const markdown = language === null && looksLikeMarkdown(text);
  const extension = markdown ? 'md' : language === null ? 'txt' : (EXTENSIONS[language] ?? 'txt');
  return {
    name: `pasted-${minuteStamp(now)}.${extension}`,
    type: markdown ? 'text/markdown' : 'text/plain',
    text,
  };
};

/** A picture the clipboard made up, which every program calls `image.png`. */
const isMadeUp = (file: { readonly name: string; readonly type: string }): boolean =>
  file.type.startsWith('image/') && /^image\.\w+$/i.test(file.name);

/**
 * The files a paste carries, or none where its words were meant. A spreadsheet's range, a Word table
 * and a web page come with a picture of themselves *and* their text; a screenshot has no text; a file
 * copied in the Finder or the Explorer has its own name, which is all the text it has.
 */
export const pastedFiles = (files: readonly File[], words: string, now: Date): readonly File[] => {
  if (files.length === 0) return [];
  const text = words.trim();
  const named = files.some((file) => file.name === text);
  // The Finder's and the Explorer's own copy: the file keeps the name it has.
  if (named) return files;
  if (text !== '' && files.every(isMadeUp)) return [];
  // The clipboard's pictures all have one name: they are named for the second they were pasted.
  const stamp = `${minuteStamp(now)}${pad(now.getSeconds())}`;
  let nth = 0;
  return files.map((file) => {
    if (!isMadeUp(file)) return file;
    nth += 1;
    const extension = /\.(\w+)$/.exec(file.name)?.[1] ?? 'png';
    const suffix = nth === 1 ? '' : `-${String(nth)}`;
    return new File([file], `pasted-image-${stamp}${suffix}.${extension}`, {
      type: file.type,
      lastModified: file.lastModified,
    });
  });
};
