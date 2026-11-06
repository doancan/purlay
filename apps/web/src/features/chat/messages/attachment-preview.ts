/**
 * Which attached files can be read in place, and how (D-210): a table for a CSV, the formatted text for
 * Markdown, a coloured block for code — each as markdown the renderer already draws safely, so a file's
 * words are never HTML. Only what is text by its name, and small enough to read at once.
 */
import { asCodeBlock } from '../composer/composer-text';
import { tablePreview } from '../composer/paste';

/** The largest file read to be previewed; anything bigger is a download only. */
export const PREVIEW_BYTES_MAX = 512 * 1024;
/** A preview shows the top of a file: these many rows of a table, these many characters of text. */
const PREVIEW_ROWS = 50;
const PREVIEW_CHARS = 64_000;

/** A file's extension to the highlighter's language (`highlight.ts`); `null` for plain text. */
const CODE: Readonly<Record<string, string | null>> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'tsx',
  json: 'json',
  py: 'python',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  scss: 'scss',
  html: 'html',
  xml: 'xml',
  diff: 'diff',
  patch: 'diff',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  kt: 'kotlin',
  swift: 'swift',
  toml: 'toml',
  graphql: 'graphql',
  lua: 'lua',
  ini: 'ini',
  ps1: 'powershell',
  proto: 'proto',
  txt: null,
  log: null,
};

export type PreviewKind =
  | { readonly kind: 'table' }
  | { readonly kind: 'markdown' }
  | { readonly kind: 'code'; readonly language: string | null };

/** How a file can be previewed, by its name and size, or `null` when it cannot. */
export const previewOf = (fileName: string, sizeBytes: number): PreviewKind | null => {
  if (sizeBytes > PREVIEW_BYTES_MAX) return null;
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (extension === undefined) return null;
  if (extension === 'csv' || extension === 'tsv') return { kind: 'table' };
  if (extension === 'md' || extension === 'markdown') return { kind: 'markdown' };
  if (extension in CODE) return { kind: 'code', language: CODE[extension] ?? null };
  return null;
};

export interface Preview {
  readonly markdown: string;
  /** What was left out: the rows of a table past the first, or the rest of a long text. */
  readonly more: { readonly rows: number } | { readonly cut: true } | null;
}

/** The start of a long text, ended at a line so nothing is cut in half. */
const head = (text: string): { readonly text: string; readonly cut: boolean } => {
  if (text.length <= PREVIEW_CHARS) return { text, cut: false };
  const end = text.lastIndexOf('\n', PREVIEW_CHARS);
  return { text: text.slice(0, end > 0 ? end : PREVIEW_CHARS), cut: true };
};

/** A file's words as the markdown its preview draws. */
export const previewMarkdown = (preview: PreviewKind, text: string): Preview => {
  if (preview.kind === 'table') {
    const table = tablePreview(text, PREVIEW_ROWS);
    if (table !== null) {
      return { markdown: table.markdown, more: table.more > 0 ? { rows: table.more } : null };
    }
  }
  const start = head(text);
  const more = start.cut ? ({ cut: true } as const) : null;
  if (preview.kind === 'markdown') return { markdown: start.text, more };
  // Code, and a CSV that is not a table after all, is shown as written.
  const language = preview.kind === 'code' ? preview.language : null;
  return { markdown: asCodeBlock(start.text, language), more };
};
